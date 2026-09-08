"""Alert email rendering for the MuBWeM checker.

Two mails, one shape: a status banner, a card with a fixed field table, and a
"View details" button that lands on the monitor's own page in the dashboard.

  DOWN       monitor, URL, root cause, incident start, location
  RECOVERED  the same, plus when it was resolved

Everything is inline-styled, table-based and 600px wide because that is the
only layout email clients agree on: no stylesheet, no webfont, no external
image, no flexbox. Every cell carries an explicit background colour so a
dark-mode client cannot invert the card into grey-on-grey.

Each render also returns a plain-text alternative. SES sends both parts, which
is what keeps the mail readable in a text-only client - and it is the body the
checker falls back to when it has to publish through SNS instead.

Stdlib only, so lambda/checker/ stays deployable with no bundling step.
"""

from datetime import datetime, timezone
from html import escape

# ----------------------------------------------------------------------------
# Palette - kept here rather than inlined so the two mails cannot drift apart.
# ----------------------------------------------------------------------------
DOWN_COLOR = "#c0392b"
UP_COLOR = "#1e8449"
PAGE_BG = "#f4f5f7"
CARD_BG = "#ffffff"
RULE = "#e5e7eb"
LABEL_FG = "#6b7280"
VALUE_FG = "#111827"
MUTED_FG = "#8a9099"
LINK_FG = "#1a5fb4"

# A check runs from exactly one region (the stack's own), so this only needs
# the regions someone might plausibly deploy MuBWeM into. An unmapped code
# falls through to the bare code rather than guessing at a city.
REGION_LABELS = {
    "us-east-1": "N. Virginia, USA",
    "us-east-2": "Ohio, USA",
    "us-west-1": "N. California, USA",
    "us-west-2": "Oregon, USA",
    "ca-central-1": "Montreal, Canada",
    "sa-east-1": "Sao Paulo, Brazil",
    "eu-west-1": "Dublin, Ireland",
    "eu-west-2": "London, UK",
    "eu-west-3": "Paris, France",
    "eu-central-1": "Frankfurt, Germany",
    "eu-north-1": "Stockholm, Sweden",
    "eu-south-1": "Milan, Italy",
    "ap-south-1": "Mumbai, India",
    "ap-southeast-1": "Singapore",
    "ap-southeast-2": "Sydney, Australia",
    "ap-southeast-3": "Jakarta, Indonesia",
    "ap-northeast-1": "Tokyo, Japan",
    "ap-northeast-2": "Seoul, South Korea",
    "ap-east-1": "Hong Kong",
    "me-south-1": "Bahrain",
    "af-south-1": "Cape Town, South Africa",
}


# ----------------------------------------------------------------------------
# Display formatting
#
# None of this touches a stored value. The ISO8601 strings written to DynamoDB
# are sort keys shared with the API and the seed script; they are formatted for
# a human here and nowhere else.
# ----------------------------------------------------------------------------
def region_label(code):
    """Turn a region code into "Sydney, Australia (ap-southeast-2)"."""
    if not code:
        return "Unknown"
    friendly = REGION_LABELS.get(code)
    return "%s (%s)" % (friendly, code) if friendly else code


def human_time(value):
    """An ISO8601 string (or datetime) as "08 Sep 2026, 14:02:31 UTC".

    Falls back to the raw value if it will not parse - an ugly timestamp in the
    mail beats a mail that never sends.
    """
    if not value:
        return "Unknown"
    if isinstance(value, datetime):
        parsed = value
    else:
        try:
            parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        except ValueError:
            return str(value)
    return parsed.astimezone(timezone.utc).strftime("%d %b %Y, %H:%M:%S UTC")


def human_duration(seconds):
    """Seconds as "48s", "35m 4s", "2h 11m" or "1d 3h"."""
    try:
        total = int(seconds)
    except (TypeError, ValueError):
        return None
    if total < 0:
        return None
    if total < 60:
        return "%ds" % total
    if total < 3600:
        return "%dm %ds" % (total // 60, total % 60)
    if total < 86400:
        return "%dh %dm" % (total // 3600, (total % 3600) // 60)
    return "%dd %dh" % (total // 86400, (total % 86400) // 3600)


# ----------------------------------------------------------------------------
# HTML fragments
# ----------------------------------------------------------------------------
def _row(label, value_html, last=False):
    border = "" if last else "border-bottom:1px solid %s;" % RULE
    return (
        "<tr>"
        '<td style="padding:14px 16px 14px 0;%s background-color:%s;'
        "font-family:Helvetica,Arial,sans-serif;font-size:11px;"
        "letter-spacing:0.08em;text-transform:uppercase;color:%s;"
        'width:36%%;vertical-align:top;">%s</td>'
        '<td style="padding:14px 0;%s background-color:%s;'
        "font-family:Helvetica,Arial,sans-serif;font-size:14px;line-height:20px;"
        'color:%s;word-break:break-word;vertical-align:top;">%s</td>'
        "</tr>"
    ) % (
        border,
        CARD_BG,
        LABEL_FG,
        escape(label),
        border,
        CARD_BG,
        VALUE_FG,
        value_html,
    )


def _button(url, color):
    """A bulletproof button: padding on the anchor, solid bgcolor underneath."""
    safe = escape(url, quote=True)
    return (
        '<table role="presentation" cellpadding="0" cellspacing="0" border="0">'
        '<tr><td align="center" bgcolor="%s" style="border-radius:6px;">'
        '<a href="%s" target="_blank" style="display:inline-block;'
        "padding:13px 34px;font-family:Helvetica,Arial,sans-serif;font-size:15px;"
        "font-weight:bold;color:#ffffff;text-decoration:none;border-radius:6px;"
        'background-color:%s;">View details</a>'
        "</td></tr></table>"
    ) % (color, safe, color)


def _shell(status_word, color, headline, rows_html, details_url, footer_note):
    button_block = ""
    if details_url:
        button_block = (
            '<tr><td align="center" style="padding:30px 32px 0 32px;'
            'background-color:%s;">%s</td></tr>'
            '<tr><td align="center" style="padding:10px 32px 0 32px;'
            "background-color:%s;font-family:Helvetica,Arial,sans-serif;"
            'font-size:12px;line-height:18px;color:%s;">'
            "You will be asked to sign in first.</td></tr>"
        ) % (CARD_BG, _button(details_url, color), CARD_BG, MUTED_FG)

    return (
        '<div style="background-color:%(page_bg)s;margin:0;padding:24px 12px;">'
        # Preheader: the grey line an inbox shows next to the subject.
        '<div style="display:none;max-height:0;overflow:hidden;opacity:0;">'
        "%(preheader)s</div>"
        '<table role="presentation" cellpadding="0" cellspacing="0" border="0"'
        ' width="100%%" style="background-color:%(page_bg)s;">'
        '<tr><td align="center">'
        '<table role="presentation" cellpadding="0" cellspacing="0" border="0"'
        ' width="600" style="width:100%%;max-width:600px;'
        "background-color:%(card_bg)s;border-radius:10px;overflow:hidden;"
        'border:1px solid %(rule)s;">'
        # Banner
        '<tr><td style="background-color:%(color)s;padding:18px 32px;">'
        '<table role="presentation" cellpadding="0" cellspacing="0" border="0"'
        ' width="100%%"><tr>'
        '<td align="left" style="font-family:Helvetica,Arial,sans-serif;'
        'font-size:17px;font-weight:bold;letter-spacing:0.02em;color:#ffffff;">'
        "MuBWeM</td>"
        '<td align="right" style="font-family:Helvetica,Arial,sans-serif;'
        'font-size:11px;font-weight:bold;letter-spacing:0.12em;color:#ffffff;">'
        "%(status_word)s</td>"
        "</tr></table></td></tr>"
        # Headline
        '<tr><td style="padding:30px 32px 0 32px;background-color:%(card_bg)s;'
        "font-family:Helvetica,Arial,sans-serif;font-size:20px;line-height:28px;"
        'font-weight:bold;color:%(value_fg)s;">%(headline)s</td></tr>'
        # Field table
        '<tr><td style="padding:10px 32px 0 32px;background-color:%(card_bg)s;">'
        '<table role="presentation" cellpadding="0" cellspacing="0" border="0"'
        ' width="100%%" style="background-color:%(card_bg)s;">%(rows)s</table>'
        "</td></tr>"
        "%(button)s"
        # Footer
        '<tr><td style="padding:28px 32px 26px 32px;background-color:%(card_bg)s;'
        "font-family:Helvetica,Arial,sans-serif;font-size:12px;line-height:18px;"
        'color:%(muted)s;">%(footer)s</td></tr>'
        "</table></td></tr></table></div>"
    ) % {
        "page_bg": PAGE_BG,
        "card_bg": CARD_BG,
        "rule": RULE,
        "color": color,
        "status_word": escape(status_word),
        "headline": escape(headline),
        "rows": rows_html,
        "button": button_block,
        "value_fg": VALUE_FG,
        "muted": MUTED_FG,
        "footer": escape(footer_note),
        "preheader": escape(headline),
    }


def _text(headline, fields, details_url, footer_note):
    width = max(len(label) for label, _ in fields)
    lines = [headline, ""]
    lines += ["  %-*s   %s" % (width, label, value) for label, value in fields]
    if details_url:
        lines += ["", "View details (sign-in required):", "  " + details_url]
    lines += ["", "--", footer_note]
    return "\n".join(lines)


def _url_link(url):
    return '<a href="%s" style="color:%s;text-decoration:underline;">%s</a>' % (
        escape(url, quote=True),
        LINK_FG,
        escape(url),
    )


# ----------------------------------------------------------------------------
# The two mails
#
# ctx keys: name, url, root_cause, started_at, resolved_at, duration_sec,
# location (a region code), details_url. Every value is escaped on the way in -
# root_cause is exception text and name/url are editable from the dashboard.
# ----------------------------------------------------------------------------
def render_down(ctx):
    """Return (subject, text_body, html_body) for a newly opened incident."""
    name = ctx.get("name") or ctx.get("siteId") or "Monitor"
    url = ctx.get("url") or ""
    root_cause = ctx.get("root_cause") or "Unknown"
    started = human_time(ctx.get("started_at"))
    location = region_label(ctx.get("location"))
    details = ctx.get("details_url") or ""

    headline = "%s is down" % name
    footer = "Sent by MuBWeM. This check ran from %s." % location

    rows = "".join(
        [
            _row("Monitor", escape(name)),
            _row("URL", _url_link(url) if url else "&mdash;"),
            _row("Root cause", escape(root_cause)),
            _row("Incident started", escape(started)),
            _row("Location", escape(location), last=True),
        ]
    )
    fields = [
        ("Monitor", name),
        ("URL", url or "-"),
        ("Root cause", root_cause),
        ("Incident started", started),
        ("Location", location),
    ]

    return (
        "[MuBWeM] DOWN - %s" % name,
        _text(headline.upper(), fields, details, footer),
        _shell("DOWN", DOWN_COLOR, headline, rows, details, footer),
    )


def render_recovered(ctx):
    """Return (subject, text_body, html_body) for an incident that just closed."""
    name = ctx.get("name") or ctx.get("siteId") or "Monitor"
    url = ctx.get("url") or ""
    root_cause = ctx.get("root_cause") or "Unknown"
    started = human_time(ctx.get("started_at"))
    location = region_label(ctx.get("location"))
    details = ctx.get("details_url") or ""

    # Downtime rides along with the resolved time rather than claiming a row of
    # its own - it is derived from the two timestamps already on screen.
    resolved = human_time(ctx.get("resolved_at"))
    downtime = human_duration(ctx.get("duration_sec"))
    if downtime:
        resolved = "%s (down for %s)" % (resolved, downtime)

    headline = "%s is back up" % name
    footer = "Sent by MuBWeM. This check ran from %s." % location

    rows = "".join(
        [
            _row("Monitor", escape(name)),
            _row("URL", _url_link(url) if url else "&mdash;"),
            _row("Root cause", escape(root_cause)),
            _row("Incident started", escape(started)),
            _row("Resolved at", escape(resolved)),
            _row("Location", escape(location), last=True),
        ]
    )
    fields = [
        ("Monitor", name),
        ("URL", url or "-"),
        ("Root cause", root_cause),
        ("Incident started", started),
        ("Resolved at", resolved),
        ("Location", location),
    ]

    return (
        "[MuBWeM] RESOLVED - %s" % name,
        _text(headline.upper(), fields, details, footer),
        _shell("RESOLVED", UP_COLOR, headline, rows, details, footer),
    )
