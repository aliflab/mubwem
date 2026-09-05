"""MuBWeM admin API Lambda.

Behind the same API Gateway HTTP API and the same Cognito JWT authorizer as
GET /status, serving nine routes from one function:

  GET    /admin/users             list users and their role
  POST   /admin/users             create a user in a role
  PATCH  /admin/users/{username}  change a user's role (and enabled state)
  DELETE /admin/users/{username}  delete a user

  GET    /admin/sites             list every site, admin view
  POST   /admin/sites             create a site
  PATCH  /admin/sites/{siteId}    edit an allow-listed set of site fields
  DELETE /admin/sites/{siteId}    delete a site row
  POST   /admin/sites/preview     suggest a monitor name for a URL

The last of those is the only route in this codebase that makes an outbound
request to an address the caller chooses. It carries its own SSRF notice, in
the "Site preview" section below; read that before touching it.

AUTHORIZATION - read this before changing anything below.

The API Gateway JWT authorizer proves exactly one thing: the caller presented
a valid, unexpired id token issued by our user pool to our app client. It says
nothing whatsoever about which Cognito group that user is in. Every
group-level decision is made here, in this file, by _user_groups() and
_require().

The rule those two enforce is: authorize only on positive evidence. A request
is allowed through only when a group name we recognise is actually present in
the token's `cognito:groups` claim and intersects the set the route requires.
Anything else - claim absent, claim malformed, claim empty, event shaped
differently than expected, an exception while looking - yields an empty set of
groups, and an empty set intersects nothing, so the answer is 403. There is no
path through this file where a failure to determine the caller's groups
results in access being granted.

Roles:

  Admins   everything - manage users, and create/edit/delete sites
  Editors  create and edit sites; no user management, no site deletion
  Viewers  the read-only dashboard, and nothing here - a Viewer has no reason
           to reach any /admin/* route, not even a read-only one

The frontend does its own `cognito:groups` check to decide which controls to
draw, which is a convenience and not a security boundary. This file is the
boundary.
"""

import http.client
import ipaddress
import json
import logging
import os
import re
import secrets
import socket
import ssl
import string
import time
import urllib.parse
from datetime import datetime, timezone
from html.parser import HTMLParser

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

logger = logging.getLogger()
logger.setLevel(logging.INFO)

SITES_TABLE = os.environ["SITES_TABLE"]
USER_POOL_ID = os.environ["USER_POOL_ID"]

_boto_config = Config(retries={"max_attempts": 3, "mode": "standard"})
_dynamodb = boto3.resource("dynamodb", config=_boto_config)
sites_table = _dynamodb.Table(SITES_TABLE)
cognito = boto3.client("cognito-idp", config=_boto_config)

# Site fields a client is allowed to set. Everything else on a Sites item -
# siteId, createdAt - is decided by this function, never by the request body.
EDITABLE_SITE_FIELDS = (
    "name",
    "url",
    "brand",
    "checkIntervalSec",
    "enabled",
)

# The role name the API speaks, and the Cognito group it maps to.
ROLE_TO_GROUP = {"Admin": "Admins", "Editor": "Editors", "Viewer": "Viewers"}
GROUP_TO_ROLE = {group: role for role, group in ROLE_TO_GROUP.items()}

# EventBridge Scheduler's floor is one minute, and the checker sweeps every
# enabled site on every invocation - it does not compare checkIntervalSec
# against anything. So a site set to 30s is not checked twice a minute; it is
# checked once, and the dashboard's countdown ring just runs two cycles per
# real check, which looks like it is working. Rejecting the value at the write
# path is the only place this can be made honest.
MIN_CHECK_INTERVAL_SEC = 60
MAX_CHECK_INTERVAL_SEC = 86400

# One page is plenty for a handful of internal users; the cap is here so a
# surprising pool size cannot turn a list into an unbounded fan-out of
# AdminListGroupsForUser calls.
MAX_USER_PAGES = 5
USERS_PER_PAGE = 60

_SLUG_STRIP_RE = re.compile(r"[^a-z0-9]+")


# ---------------------------------------------------------------------------
# Authorization
# ---------------------------------------------------------------------------
def _user_groups(event):
    """Returns the set of Cognito groups from the JWT authorizer claims.

    Returns an empty set on anything unexpected - missing claims, a malformed
    groups value, whatever. An empty set can authorize nothing. Never guess
    or default to a permissive group here.
    """
    try:
        claims = event["requestContext"]["authorizer"]["jwt"]["claims"]
        groups = claims.get("cognito:groups", "")
        # API Gateway JWT authorizer may deliver this as a JSON-ish string,
        # a comma-separated string, or a list depending on token shape -
        # handle defensively, never raise here.
        if isinstance(groups, list):
            return set(groups)
        if isinstance(groups, str) and groups:
            return set(g.strip() for g in groups.strip("[]").split(",") if g.strip())
        return set()
    except Exception:
        return set()


ADMIN_ONLY = {"Admins"}
CAN_WRITE_SITES = {"Admins", "Editors"}


def _require(event, allowed_groups):
    """Returns None if authorized, else a 403 response dict to return immediately."""
    if not (_user_groups(event) & allowed_groups):
        return {"statusCode": 403, "body": json.dumps({"error": "forbidden"})}
    return None


def _caller(event):
    """The caller's own identity claims, or empty dict if they cannot be read.

    Used only to stop an admin deleting themselves. Empty here means the
    self-delete guard has nothing to compare against, so the delete is
    refused rather than allowed - see _handle_delete_user.
    """
    try:
        claims = event["requestContext"]["authorizer"]["jwt"]["claims"]
    except Exception:
        return {}
    if not isinstance(claims, dict):
        return {}
    return claims


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------
def _iso(dt):
    """ISO8601 UTC with milliseconds.

    Byte-identical to the _iso() in the checker, the status API and
    seed_sites.py. UptimeChecks.checkedAt and Incidents.startedAt are sort
    keys, so all four must format the same way or range queries break.
    """
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def _response(status_code, body):
    return {
        "statusCode": status_code,
        "headers": {
            "content-type": "application/json",
            # Admin reads must never be served stale: a toggle flipped a
            # second ago has to be what the next GET shows.
            "cache-control": "no-store",
        },
        "body": json.dumps(body, default=str),
    }


def _body(event):
    """Parsed JSON request body, or {} - a malformed body is never a crash."""
    raw = (event or {}).get("body") or "{}"
    if (event or {}).get("isBase64Encoded"):
        import base64

        try:
            raw = base64.b64decode(raw).decode("utf-8")
        except Exception:
            return {}
    try:
        parsed = json.loads(raw)
    except (ValueError, TypeError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _path_param(event, name):
    params = (event or {}).get("pathParameters") or {}
    value = params.get(name)
    if not value:
        return None
    # API Gateway usually hands these over decoded, but an email in a path
    # segment is worth being sure about.
    return urllib.parse.unquote(str(value))


def _plain(value):
    """DynamoDB Decimals to JSON-friendly numbers."""
    from decimal import Decimal

    if isinstance(value, Decimal):
        return int(value) if value % 1 == 0 else float(value)
    if isinstance(value, list):
        return [_plain(v) for v in value]
    if isinstance(value, dict):
        return {k: _plain(v) for k, v in value.items()}
    return value


def _slugify(name):
    slug = _SLUG_STRIP_RE.sub("-", str(name).lower()).strip("-")
    return slug[:64]


def _temp_password():
    """A temporary password generated here, never accepted from the client.

    The user replaces it on first hosted-UI login, exactly as with the CLI
    bootstrap flow. Satisfies the pool policy (>=8 chars, upper, lower, digit)
    and carries a symbol besides, so it still works if the policy tightens.
    """
    alphabet = string.ascii_letters + string.digits
    while True:
        candidate = "".join(secrets.choice(alphabet) for _ in range(16))
        if (
            any(c.islower() for c in candidate)
            and any(c.isupper() for c in candidate)
            and any(c.isdigit() for c in candidate)
        ):
            return candidate + "!"


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------
class Invalid(Exception):
    """A 400: the request is well-formed JSON but says something unusable."""


def _clean_site_fields(payload, require_name_and_url):
    """Pull only the allow-listed site fields out of a request body.

    An explicit allow-list, not a merge: whatever else the body carries is
    dropped on the floor, so a caller cannot decorate a Sites row with
    attributes of their own choosing.
    """
    fields = {}

    if "name" in payload or require_name_and_url:
        name = payload.get("name")
        if not isinstance(name, str) or not name.strip():
            raise Invalid("name is required and must be a non-empty string")
        fields["name"] = name.strip()[:200]

    if "url" in payload or require_name_and_url:
        url = payload.get("url")
        if not isinstance(url, str) or not url.strip().startswith("https://"):
            raise Invalid("url is required and must start with https://")
        fields["url"] = url.strip()[:2000]

    if "brand" in payload:
        brand = payload.get("brand")
        if not isinstance(brand, str) or not brand.strip():
            raise Invalid("brand must be a non-empty string")
        fields["brand"] = brand.strip()[:120]

    if "checkIntervalSec" in payload:
        raw = payload.get("checkIntervalSec")
        if isinstance(raw, bool) or not isinstance(raw, (int, float)):
            raise Invalid("checkIntervalSec must be a number")
        interval = int(raw)
        if not MIN_CHECK_INTERVAL_SEC <= interval <= MAX_CHECK_INTERVAL_SEC:
            raise Invalid(
                "checkIntervalSec must be between %d and %d - checks run at "
                "most once a minute, which is the shortest interval "
                "EventBridge Scheduler supports"
                % (MIN_CHECK_INTERVAL_SEC, MAX_CHECK_INTERVAL_SEC)
            )
        fields["checkIntervalSec"] = interval

    if "enabled" in payload:
        if not isinstance(payload["enabled"], bool):
            raise Invalid("enabled must be true or false")
        fields["enabled"] = payload["enabled"]

    return fields


def _role_to_group(role):
    if not isinstance(role, str):
        raise Invalid("role is required")
    normalised = role.strip().capitalize()
    if normalised not in ROLE_TO_GROUP:
        raise Invalid("role must be one of Admin, Editor, Viewer")
    return ROLE_TO_GROUP[normalised]


def _valid_email(email):
    if not isinstance(email, str):
        return False
    email = email.strip()
    return bool(email) and "@" in email and " " not in email and len(email) <= 320


# ---------------------------------------------------------------------------
# Site preview: fetching an operator-supplied URL
# ---------------------------------------------------------------------------
# SSRF NOTICE - READ THIS BEFORE CHANGING ANYTHING IN THIS SECTION.
#
# Every other outbound call in this file goes to DynamoDB or Cognito, at an
# address the AWS SDK chooses. This one goes wherever the request body says,
# which makes it the only server-side request forgery surface in the codebase.
# The caller is an authenticated Admin or Editor, so this is not anonymous
# SSRF - but a stolen Editor token must not become a window into the VPC, the
# instance metadata service, or anything else that trusts network position
# instead of credentials.
#
# Each protection below answers one specific failure mode. Deleting any one of
# them re-opens the mode named with it.
#
#   https:// only  ->  _preview_target()
#       Stops file://, gopher://, ftp:// and the other schemes a general URL
#       opener would happily dereference, and keeps the rule identical to the
#       one _clean_site_fields() already applies to a site's url.
#
#   Resolve first, judge every answer  ->  _resolve_public_addrs()
#       getaddrinfo() is called here, and EVERY address it returns is tested.
#       Testing only the first would let a hostname publishing one public and
#       one loopback A record through on a round robin. One bad address
#       rejects the whole hostname.
#
#   Connect to the address that was judged  ->  _open_pinned_connection()
#       The socket is opened against the exact IP that passed the check, while
#       SNI and certificate verification stay bound to the hostname. Handing
#       the hostname to a URL opener instead would let it resolve a second
#       time and get a different answer - DNS rebinding, where a name is
#       public at check time and 169.254.169.254 a millisecond later. This is
#       the step naive implementations leave out, and without it the check
#       above is decoration.
#
#   IPv4-mapped / 6to4 / Teredo unwrapping  ->  _blocked_ip()
#       ::ffff:127.0.0.1 is loopback in an IPv6 costume. Unwrapping the
#       embedded IPv4 keeps the range test correct regardless of the
#       interpreter's patch level, rather than trusting IPv6Address.is_private
#       to have been fixed in whatever runtime this lands on.
#
#   Per-socket timeout and a whole-request deadline  ->  PREVIEW_*_SEC
#       A host that accepts a connection and then says nothing would otherwise
#       hold a Lambda invocation open for its full 15s timeout. The deadline
#       also bounds the redirect chain in wall-clock terms, not just in hops.
#
#   At most PREVIEW_MAX_REDIRECTS hops, each re-validated  ->  _fetch_page()
#       A Location header is attacker-influenced input that has not been
#       checked yet. Start at a public URL, redirect to an internal one is the
#       standard bypass, so every hop re-enters the same scheme and address
#       checks as the original URL. No hop is trusted for having come from a
#       host that passed.
#
#   Hard read cap  ->  PREVIEW_MAX_BYTES
#       Enforced while reading from the socket, so a lying or absent
#       Content-Length changes nothing, and Accept-Encoding: identity keeps
#       the cap measured in the same bytes the sender spent. A <title> that
#       has not shown up in 64KB is not worth the memory.
#
#   Text extraction only  ->  _MetadataExtractor
#       html.parser from the standard library, reading two tags. Nothing
#       fetched is executed, evaluated, deserialised, or written anywhere.
#
#   One failure answer  ->  _handle_preview_site()
#       Blocked, refused, timed out, 404 and no-title-present all produce the
#       same hostname fallback in the same body shape. Distinguishing them
#       would turn this endpoint into an oracle for what exists on the inside.
#
# Accepted residual risk: an authenticated Editor can aim this at any *public*
# address and time the answer, which is a slow and noisy port scanner. The
# reserved-range check is what keeps that pointed away from anything private.
# Rate limiting is not built.

# Per socket operation. Deliberately shorter than the deadline: a stalled read
# should fail on its own rather than burning the whole budget.
PREVIEW_SOCKET_TIMEOUT_SEC = 3.0
# Whole request, redirects included. Well inside AdminFunction's 15s timeout,
# so this endpoint fails on its own terms rather than being killed.
PREVIEW_TOTAL_DEADLINE_SEC = 8.0
PREVIEW_MAX_REDIRECTS = 2
PREVIEW_MAX_BYTES = 64 * 1024
PREVIEW_USER_AGENT = "MuBWeM-SitePreview/1.0"
PREVIEW_HTML_TYPES = ("text/html", "application/xhtml+xml")

# Built once: loads the trust store at import, not per request. The default
# context verifies the chain and checks the hostname, both of which stay on.
_PREVIEW_SSL_CONTEXT = ssl.create_default_context()


class PreviewUnavailable(Exception):
    """Detection did not work. Logged, never returned verbatim to the caller."""


def _embedded_addresses(ip):
    """`ip`, plus any IPv4 address an IPv6 form carries inside it."""
    yield ip
    if not isinstance(ip, ipaddress.IPv6Address):
        return
    if ip.ipv4_mapped:
        yield ip.ipv4_mapped
    if ip.sixtofour:
        yield ip.sixtofour
    if ip.teredo:
        # (server, client). A Teredo server inside the network is as much a
        # target as the client, so both halves are tested.
        for part in ip.teredo:
            yield part


def _blocked_ip(raw):
    """True if `raw` is anything but an ordinary public internet address.

    Fails closed: an address that cannot be parsed is not provably public, so
    it is blocked. is_global is tested last as a backstop - it also covers the
    carrier-grade NAT and documentation ranges the named predicates miss.
    """
    try:
        parsed = ipaddress.ip_address(raw)
    except ValueError:
        return True

    for ip in _embedded_addresses(parsed):
        if (
            ip.is_private
            or ip.is_loopback
            or ip.is_link_local
            or ip.is_multicast
            or ip.is_reserved
            or ip.is_unspecified
            or not ip.is_global
        ):
            return True
    return False


def _resolve_public_addrs(hostname, port):
    """Every address `hostname` resolves to - or raise if ANY is off-limits."""
    try:
        infos = socket.getaddrinfo(
            hostname, port, type=socket.SOCK_STREAM, proto=socket.IPPROTO_TCP
        )
    except socket.gaierror as exc:
        raise PreviewUnavailable("dns lookup failed: %s" % exc)

    if not infos:
        raise PreviewUnavailable("dns returned no addresses")

    resolved = []
    for family, _socktype, _proto, _canonname, sockaddr in infos:
        address = sockaddr[0]
        if _blocked_ip(address):
            # One bad answer condemns the hostname. A record set mixing a
            # public and a loopback address must not work half the time.
            raise PreviewUnavailable("blocked address %s for %s" % (address, hostname))
        resolved.append((family, sockaddr))
    return resolved


def _preview_target(url):
    """(hostname, port, request_path) for a URL this endpoint will fetch."""
    parsed = urllib.parse.urlsplit(url)

    if parsed.scheme != "https":
        raise PreviewUnavailable("scheme %r is not https" % parsed.scheme)
    if parsed.username or parsed.password:
        # https://real-host@evil/ reads as one host and connects to another.
        raise PreviewUnavailable("credentials in url")

    hostname = parsed.hostname
    if not hostname:
        raise PreviewUnavailable("no hostname in url")

    try:
        port = parsed.port or 443
    except ValueError:
        raise PreviewUnavailable("unparseable port")
    if not 1 <= port <= 65535:
        raise PreviewUnavailable("port out of range")

    path = parsed.path or "/"
    if parsed.query:
        path = path + "?" + parsed.query
    return hostname, port, path


def _open_pinned_connection(hostname, port, deadline):
    """HTTPS connection to a vetted address, still verified against `hostname`.

    The TCP connection is pinned to an IP that passed _blocked_ip(); TLS is
    negotiated with server_hostname set to the name, so certificate checking
    is unaffected. Both halves are required - see the notice above.
    """
    last_error = None
    for family, sockaddr in _resolve_public_addrs(hostname, port):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise PreviewUnavailable("deadline reached before connect")

        timeout = min(PREVIEW_SOCKET_TIMEOUT_SEC, remaining)
        sock = None
        try:
            sock = socket.socket(family, socket.SOCK_STREAM)
            sock.settimeout(timeout)
            sock.connect(sockaddr)
            tls = _PREVIEW_SSL_CONTEXT.wrap_socket(sock, server_hostname=hostname)
        except (OSError, ValueError) as exc:
            if sock is not None:
                sock.close()
            last_error = exc
            continue

        conn = http.client.HTTPSConnection(hostname, port, timeout=timeout)
        # Pre-connected. request() only calls connect() when sock is None, so
        # the vetted socket is the one that gets used - there is no second
        # name resolution anywhere in this path.
        conn.sock = tls
        return conn

    raise PreviewUnavailable("connect failed: %s" % (last_error,))


def _charset_of(content_type):
    """The charset from a Content-Type header, or utf-8 if it is unusable."""
    for part in content_type.split(";")[1:]:
        key, _, value = part.strip().partition("=")
        if key.strip().lower() == "charset":
            candidate = value.strip().strip("\"'")
            try:
                "".encode(candidate)
                return candidate
            except (LookupError, TypeError, ValueError):
                break
    return "utf-8"


def _fetch_page(url, deadline):
    """Decoded HTML for `url`, following at most PREVIEW_MAX_REDIRECTS hops."""
    current = url

    for hop in range(PREVIEW_MAX_REDIRECTS + 1):
        if time.monotonic() >= deadline:
            raise PreviewUnavailable("deadline reached")

        # Re-entered on every hop, so a redirect target gets the same scheme
        # and address checks the original URL got.
        hostname, port, path = _preview_target(current)
        conn = _open_pinned_connection(hostname, port, deadline)
        try:
            conn.request(
                "GET",
                path,
                headers={
                    "Host": hostname if port == 443 else "%s:%d" % (hostname, port),
                    "User-Agent": PREVIEW_USER_AGENT,
                    "Accept": "text/html,application/xhtml+xml",
                    # No compression: the byte cap below should measure the
                    # same bytes the sender spent, not a decompressed bomb.
                    "Accept-Encoding": "identity",
                    "Connection": "close",
                },
            )
            response = conn.getresponse()

            if response.status in (301, 302, 303, 307, 308):
                if hop >= PREVIEW_MAX_REDIRECTS:
                    raise PreviewUnavailable("too many redirects")
                location = response.getheader("Location")
                if not location:
                    raise PreviewUnavailable("redirect carried no Location")
                current = urllib.parse.urljoin(current, location)
                continue

            if not 200 <= response.status < 300:
                raise PreviewUnavailable("http %d" % response.status)

            content_type = (response.getheader("Content-Type") or "").lower()
            mime = content_type.split(";", 1)[0].strip()
            if mime and mime not in PREVIEW_HTML_TYPES:
                raise PreviewUnavailable("content-type %s" % mime)

            # read(n) takes at most n bytes off the socket. Content-Length is
            # never consulted, so a header claiming otherwise buys nothing.
            body = response.read(PREVIEW_MAX_BYTES)
        finally:
            conn.close()

        return body.decode(_charset_of(content_type), errors="replace")

    raise PreviewUnavailable("too many redirects")


class _MetadataExtractor(HTMLParser):
    """Pulls <title> and og:site_name out of HTML. Reads only; runs nothing."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.title = None
        self.site_name = None
        self._in_title = False
        self._title_parts = []

    def handle_starttag(self, tag, attrs):
        if tag == "title":
            if self.title is None and not self._title_parts:
                self._in_title = True
            return
        if tag != "meta" or self.site_name is not None:
            return

        pairs = {key.lower(): (value or "") for key, value in attrs if key}
        label = (pairs.get("property") or pairs.get("name") or "").strip().lower()
        if label == "og:site_name":
            content = pairs.get("content", "").strip()
            if content:
                self.site_name = content

    def handle_endtag(self, tag):
        if tag == "title" and self._in_title:
            self._in_title = False
            self.title = "".join(self._title_parts)

    def handle_data(self, data):
        # The bound is on fragment count, not characters: a <title> split into
        # thousands of pieces is markup abuse, not a title.
        if self._in_title and len(self._title_parts) < 64:
            self._title_parts.append(data)

    def best_name(self):
        """og:site_name wins - a title often carries a suffix like " | Home"."""
        if self.title is None and self._title_parts:
            # Body hit the byte cap mid-title; use what did arrive.
            self.title = "".join(self._title_parts)
        return self.site_name or self.title


def _suggested_name(page_html):
    parser = _MetadataExtractor()
    try:
        parser.feed(page_html)
    except Exception:  # noqa: BLE001 - broken markup is a fallback, not a 500
        pass
    return parser.best_name()


def _tidy_name(value):
    if not value:
        return None
    # Collapse the newlines and indentation pretty-printed markup leaves
    # inside a title. 200 matches the cap _clean_site_fields puts on name.
    collapsed = " ".join(str(value).split())[:200]
    return collapsed or None


def _name_from_hostname(hostname):
    """The always-available fallback: the hostname, minus a leading www."""
    return hostname[4:] if hostname.startswith("www.") else hostname


def _handle_preview_site(event):
    """POST /admin/sites/preview - suggest a monitor name for a URL.

    Always answers 200 with a usable suggestion. A blocked address, a refused
    connection, a timeout, a 500 from the target and a page with no title all
    produce the same hostname fallback and the same body: the form has to stay
    usable either way, and the caller must not learn which one happened.

    Read the SSRF notice at the top of this section before changing anything
    here or in the functions it calls.
    """
    denied = _require(event, CAN_WRITE_SITES)
    if denied:
        return denied

    payload = _body(event)
    url = payload.get("url")
    if not isinstance(url, str) or not url.strip().startswith("https://"):
        raise Invalid("url is required and must start with https://")
    url = url.strip()[:2000]

    # A malformed URL is a 400 about the caller's own input, so it says why.
    # Everything past this point is about the network and says nothing.
    try:
        hostname, _port, _path = _preview_target(url)
    except PreviewUnavailable as exc:
        raise Invalid("url is not a fetchable https address: %s" % exc)

    deadline = time.monotonic() + PREVIEW_TOTAL_DEADLINE_SEC
    suggested = None
    try:
        suggested = _tidy_name(_suggested_name(_fetch_page(url, deadline)))
    except PreviewUnavailable as exc:
        # CloudWatch gets the reason; the response does not.
        logger.info("Preview fell back for %s: %s", hostname, exc)
    except Exception:  # noqa: BLE001 - a convenience must not 500 the form
        logger.exception("Preview failed unexpectedly for %s", hostname)

    return _response(
        200,
        {
            "suggestedName": suggested or _name_from_hostname(hostname),
            "hostname": hostname,
            # Whether the name came off the page or off the hostname. Says
            # nothing about *why* a fetch failed - see "One failure answer".
            "detected": bool(suggested),
        },
    )


# ---------------------------------------------------------------------------
# Site routes
# ---------------------------------------------------------------------------
def _scan_sites():
    items = []
    kwargs = {}
    while True:
        page = sites_table.scan(**kwargs)
        items.extend(page.get("Items", []))
        if "LastEvaluatedKey" not in page:
            break
        kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]
    return items


def _handle_list_sites(event):
    denied = _require(event, CAN_WRITE_SITES)
    if denied:
        return denied

    sites = [_plain(item) for item in _scan_sites()]
    sites.sort(key=lambda s: str(s.get("name", s.get("siteId", ""))).lower())
    return _response(200, {"sites": sites})


def _handle_create_site(event):
    denied = _require(event, CAN_WRITE_SITES)
    if denied:
        return denied

    payload = _body(event)
    fields = _clean_site_fields(payload, require_name_and_url=True)

    site_id = payload.get("siteId")
    site_id = _slugify(site_id) if site_id else _slugify(fields["name"])
    if not site_id:
        raise Invalid("could not derive a siteId - pass one explicitly")

    item = {
        "siteId": site_id,
        "name": fields["name"],
        "url": fields["url"],
        "brand": fields.get("brand", "Unassigned"),
        "checkIntervalSec": fields.get("checkIntervalSec", 60),
        # A new site starts switched off. Turning it on is a deliberate act.
        "enabled": fields.get("enabled", False),
        # Server time, always. A client-supplied createdAt is not evidence of
        # anything.
        "createdAt": _iso(datetime.now(timezone.utc)),
    }

    try:
        sites_table.put_item(
            Item=item,
            # Never silently overwrite an existing site: a slug collision is a
            # 409 the caller has to resolve, not a clobbered row.
            ConditionExpression="attribute_not_exists(siteId)",
        )
    except ClientError as exc:
        if exc.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return _response(409, {"error": "site %s already exists" % site_id})
        raise

    return _response(201, {"site": item})


def _handle_update_site(event):
    denied = _require(event, CAN_WRITE_SITES)
    if denied:
        return denied

    site_id = _path_param(event, "siteId")
    if not site_id:
        raise Invalid("siteId is required")

    fields = _clean_site_fields(_body(event), require_name_and_url=False)
    if not fields:
        raise Invalid(
            "nothing to update - allowed fields are: " + ", ".join(EDITABLE_SITE_FIELDS)
        )

    # Built from the allow-list above, one placeholder per field. The request
    # body never reaches the UpdateExpression itself.
    assignments = ["#%s = :%s" % (key, key) for key in fields]
    try:
        result = sites_table.update_item(
            Key={"siteId": site_id},
            UpdateExpression="SET " + ", ".join(assignments),
            ExpressionAttributeNames={"#%s" % key: key for key in fields},
            ExpressionAttributeValues={":%s" % key: value for key, value in fields.items()},
            # An update must not conjure a site that was never created.
            ConditionExpression="attribute_exists(siteId)",
            ReturnValues="ALL_NEW",
        )
    except ClientError as exc:
        if exc.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return _response(404, {"error": "no such site: %s" % site_id})
        raise

    return _response(200, {"site": _plain(result.get("Attributes", {}))})


def _handle_delete_site(event):
    # Deleting a site is Admins only: higher blast radius than creating or
    # editing one, and an Editor who needs a site to stop being checked can
    # turn `enabled` off instead.
    denied = _require(event, ADMIN_ONLY)
    if denied:
        return denied

    site_id = _path_param(event, "siteId")
    if not site_id:
        raise Invalid("siteId is required")

    # The Sites row only. UptimeChecks and Incidents rows for this siteId are
    # left where they are: orphaned history is harmless, checks age out on
    # their own TTL, and cascading a delete across two partition keys is more
    # machinery than this earns.
    sites_table.delete_item(Key={"siteId": site_id})
    return _response(200, {"deleted": site_id})


# ---------------------------------------------------------------------------
# User routes
# ---------------------------------------------------------------------------
def _user_attribute(user, name):
    for attribute in user.get("Attributes", []):
        if attribute.get("Name") == name:
            return attribute.get("Value")
    return None


def _groups_for_user(username):
    try:
        response = cognito.admin_list_groups_for_user(
            UserPoolId=USER_POOL_ID, Username=username, Limit=10
        )
    except ClientError:
        logger.exception("Could not list groups for a user")
        return []
    return [g["GroupName"] for g in response.get("Groups", [])]


def _handle_list_users(event):
    denied = _require(event, ADMIN_ONLY)
    if denied:
        return denied

    users = []
    kwargs = {"UserPoolId": USER_POOL_ID, "Limit": USERS_PER_PAGE}
    for _ in range(MAX_USER_PAGES):
        page = cognito.list_users(**kwargs)
        for user in page.get("Users", []):
            username = user["Username"]
            groups = _groups_for_user(username)
            users.append(
                {
                    "username": username,
                    "email": _user_attribute(user, "email") or username,
                    "enabled": bool(user.get("Enabled", True)),
                    "status": user.get("UserStatus"),
                    "createdAt": user.get("UserCreateDate"),
                    "groups": groups,
                    # First recognised group wins; precedence in the pool is
                    # what makes that deterministic if there is ever more
                    # than one.
                    "role": next(
                        (GROUP_TO_ROLE[g] for g in groups if g in GROUP_TO_ROLE), None
                    ),
                }
            )
        token = page.get("PaginationToken")
        if not token:
            break
        kwargs["PaginationToken"] = token

    users.sort(key=lambda u: str(u["email"]).lower())
    return _response(200, {"users": users})


def _handle_create_user(event):
    denied = _require(event, ADMIN_ONLY)
    if denied:
        return denied

    payload = _body(event)
    email = payload.get("email")
    if not _valid_email(email):
        raise Invalid("a valid email is required")
    email = email.strip().lower()
    group = _role_to_group(payload.get("role"))

    try:
        created = cognito.admin_create_user(
            UserPoolId=USER_POOL_ID,
            Username=email,
            UserAttributes=[
                {"Name": "email", "Value": email},
                {"Name": "email_verified", "Value": "true"},
            ],
            # Generated here and never returned to the caller: Cognito emails
            # it, and the user replaces it on first login.
            TemporaryPassword=_temp_password(),
            DesiredDeliveryMediums=["EMAIL"],
        )
    except ClientError as exc:
        code = exc.response["Error"]["Code"]
        if code == "UsernameExistsException":
            return _response(409, {"error": "a user with that email already exists"})
        if code in ("InvalidParameterException", "InvalidPasswordException"):
            return _response(400, {"error": exc.response["Error"]["Message"]})
        raise

    username = created["User"]["Username"]
    cognito.admin_add_user_to_group(
        UserPoolId=USER_POOL_ID, Username=username, GroupName=group
    )

    return _response(
        201,
        {
            "user": {
                "username": username,
                "email": email,
                "role": GROUP_TO_ROLE[group],
                "enabled": True,
                "status": created["User"].get("UserStatus"),
            }
        },
    )


def _is_last_admin(username):
    """True unless another user can be confirmed to be in the Admins group.

    Fail-closed, like everything else in this file: an API error, a response
    shaped unexpectedly, an exception anywhere in the count - all return True.
    Being unable to confirm that a second admin exists is not evidence that
    one does, and guessing wrong here leaves a user pool with no admin in it
    and no way back except the CLI bootstrap step.

    Note what the return value means: True is "do not allow this", not "this
    is definitely the last admin".
    """
    admin_group = ROLE_TO_GROUP["Admin"]
    target = str(username).strip().lower()
    try:
        kwargs = {
            "UserPoolId": USER_POOL_ID,
            "GroupName": admin_group,
            "Limit": USERS_PER_PAGE,
        }
        for _ in range(MAX_USER_PAGES):
            page = cognito.list_users_in_group(**kwargs)
            for user in page.get("Users", []):
                other = str(user.get("Username") or "").strip().lower()
                if other and other != target:
                    # One confirmed admin who is not the caller is the whole
                    # question - stop looking.
                    return False
            token = page.get("NextToken")
            if not token:
                break
            kwargs["NextToken"] = token
        return True
    except Exception:
        logger.exception(
            "Could not count the %s group; refusing the self-demotion", admin_group
        )
        return True


def _handle_update_user(event):
    denied = _require(event, ADMIN_ONLY)
    if denied:
        return denied

    username = _path_param(event, "username")
    if not username:
        raise Invalid("username is required")

    payload = _body(event)
    if "role" not in payload and "enabled" not in payload:
        raise Invalid("nothing to update - pass role and/or enabled")

    # Resolved before anything is applied, because the last-admin guard below
    # has to know what the role is being changed *to*.
    new_group = _role_to_group(payload["role"]) if "role" in payload else None

    # Last-admin guard. Reaching this line means _require() accepted the
    # caller as an Admin, so "target is me, and the new role is not Admin" is
    # exactly the request that takes Admins away from the caller - no separate
    # lookup of their current groups is needed to establish that.
    #
    # Self-demotion only. An admin changing someone else's role stays an admin
    # either way, so the invariant "at least one admin exists" is never in
    # question and the count is not worth paying for.
    if (
        new_group is not None
        and new_group != ROLE_TO_GROUP["Admin"]
        and _is_self(event, username)
        and _is_last_admin(username)
    ):
        return _response(
            409,
            {
                "error": (
                    "cannot remove Admins role: you are the last remaining "
                    "admin"
                )
            },
        )

    if "enabled" in payload:
        if not isinstance(payload["enabled"], bool):
            raise Invalid("enabled must be true or false")
        if not payload["enabled"] and _is_self(event, username):
            return _response(
                409, {"error": "you cannot disable your own account"}
            )

    try:
        if "role" in payload:
            group = new_group
            # Leave every group we recognise, then join the new one. Doing it
            # in that order means a user is never briefly in two roles.
            for current in _groups_for_user(username):
                if current in GROUP_TO_ROLE and current != group:
                    cognito.admin_remove_user_from_group(
                        UserPoolId=USER_POOL_ID, Username=username, GroupName=current
                    )
            cognito.admin_add_user_to_group(
                UserPoolId=USER_POOL_ID, Username=username, GroupName=group
            )

        if "enabled" in payload:
            if payload["enabled"]:
                cognito.admin_enable_user(UserPoolId=USER_POOL_ID, Username=username)
            else:
                cognito.admin_disable_user(UserPoolId=USER_POOL_ID, Username=username)
    except ClientError as exc:
        if exc.response["Error"]["Code"] == "UserNotFoundException":
            return _response(404, {"error": "no such user"})
        raise

    groups = _groups_for_user(username)
    return _response(
        200,
        {
            "user": {
                "username": username,
                "groups": groups,
                "role": next(
                    (GROUP_TO_ROLE[g] for g in groups if g in GROUP_TO_ROLE), None
                ),
            }
        },
    )


def _is_self(event, target_username):
    """True if `target_username` looks like the caller's own account.

    Compares against sub, cognito:username and email from the caller's own
    token. If none of those can be read the answer is True, not False: the
    guard exists to stop an admin locking themselves out, so being unable to
    tell who is asking has to block the delete, not wave it through.
    """
    claims = _caller(event)
    if not claims:
        return True

    target = str(target_username).strip().lower()
    candidates = {
        str(claims.get("sub") or "").strip().lower(),
        str(claims.get("cognito:username") or "").strip().lower(),
        str(claims.get("email") or "").strip().lower(),
    }
    candidates.discard("")
    if not candidates:
        return True
    return target in candidates


def _handle_delete_user(event):
    denied = _require(event, ADMIN_ONLY)
    if denied:
        return denied

    username = _path_param(event, "username")
    if not username:
        raise Invalid("username is required")

    # Nobody deletes themselves here. The last admin doing so would leave a
    # pool with no way back in short of the CLI bootstrap step again.
    if _is_self(event, username):
        return _response(
            409,
            {
                "error": (
                    "you cannot delete your own account - ask another admin, "
                    "or use the AWS CLI"
                )
            },
        )

    try:
        cognito.admin_delete_user(UserPoolId=USER_POOL_ID, Username=username)
    except ClientError as exc:
        if exc.response["Error"]["Code"] == "UserNotFoundException":
            return _response(404, {"error": "no such user"})
        raise

    return _response(200, {"deleted": username})


# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------
ROUTES = {
    "GET /admin/users": _handle_list_users,
    "POST /admin/users": _handle_create_user,
    "PATCH /admin/users/{username}": _handle_update_user,
    "DELETE /admin/users/{username}": _handle_delete_user,
    "GET /admin/sites": _handle_list_sites,
    "POST /admin/sites": _handle_create_site,
    "PATCH /admin/sites/{siteId}": _handle_update_site,
    "DELETE /admin/sites/{siteId}": _handle_delete_site,
    "POST /admin/sites/preview": _handle_preview_site,
}


def lambda_handler(event, context):  # noqa: ARG001 - signature fixed by Lambda
    route_key = (event or {}).get("routeKey") or ""
    handler = ROUTES.get(route_key)
    if handler is None:
        # Unrecognised route: 404, and no hint about what does exist.
        return _response(404, {"error": "not found"})

    try:
        return handler(event)
    except Invalid as exc:
        return _response(400, {"error": str(exc)})
    except Exception:  # noqa: BLE001 - always answer with JSON, never a stack trace
        logger.exception("Admin route failed: %s", route_key)
        return _response(500, {"error": "internal error"})
