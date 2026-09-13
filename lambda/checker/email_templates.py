"""Alert email rendering for the MuBWeM checker.

Two mails, one shape: a status banner, a headline, a labelled field table, a
"View details" button onto that monitor's page in the dashboard, and a footer.

  DOWN       monitor, URL, root cause, incident start, location
  RECOVERED  the same, plus when it was resolved and how long it was down

Why tables and inline styles, not divs and a stylesheet. This has to render in
Gmail web, Gmail mobile, Outlook desktop and Apple Mail, and those disagree on
almost everything modern. Outlook's engine is Word's: it ignores flexbox, grid
and most positioning, and several clients strip a <style> block outright. A
<table> with inline styles on every cell is the one construction all of them
lay out the same way, so the field list is a real table with a label cell and a
value cell per row rather than styled divs - a client that drops the CSS still
gets a two-column table instead of a collapsed stack.

The button follows the same rule: the background colour and the padding live
on the <td>, not on the <a>. Outlook frequently ignores padding and
border-radius set on an anchor, which would leave bare underlined text where
the button should be; a coloured, padded cell survives, losing only the
rounded corners.

Every cell also carries an explicit background colour so a dark-mode client
cannot invert the card into grey-on-grey, and the card is 600px because that
is the width every client's preview pane assumes.

Each render also returns a plain-text alternative carrying the same fields in
the same order, aligned on padded labels. SES sends both parts, which is what
keeps the mail readable in a text-only client - and it is the body the checker
falls back to when it has to publish through SNS instead. SNS appends its own
unsubscribe block below that body; everything above it is ours.

Every row is optional. Incidents opened before rootCause and region existed
carry neither, so a missing value drops its whole row rather than printing
"Unknown" or an empty cell, and the rows that remain still align.

Stdlib only, so lambda/checker/ stays deployable with no bundling step.
"""

import os
from datetime import datetime, timezone
from html import escape
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

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

# Location is a field row again, so the footer no longer carries the region.
FOOTER_NOTE = "Sent by MuBWeM."

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

# What CHECK_REGION falls back to when the stack never set it. Not a region,
# so it must not be rendered as one.
UNKNOWN_REGION = "unknown"


# ----------------------------------------------------------------------------
# Display formatting
#
# None of this touches a stored value. The ISO8601 strings written to DynamoDB
# are sort keys shared with the API and the seed script; they are formatted for
# a human here and nowhere else.
# ----------------------------------------------------------------------------
def region_label(code):
    """Turn a region code into "Sydney, Australia (ap-southeast-2)".

    None when there is no usable region, so the Location row is dropped rather
    than claiming the check ran from somewhere called "unknown".
    """
    if not code or str(code).strip().lower() == UNKNOWN_REGION:
        return None
    friendly = REGION_LABELS.get(code)
    return "%s (%s)" % (friendly, code) if friendly else str(code)


def _display_zone():
    """The zone alert times are printed in: the stack's displayTimezone.

    This is the deployment default the dashboard also starts from. A viewer's
    own pick on /settings lives in their browser and never reaches the checker.
    An empty or unknown name falls back to UTC - a mail in the wrong zone beats
    a checker that fails to import.
    """
    name = os.environ.get("DISPLAY_TIMEZONE", "").strip()
    if not name:
        return timezone.utc
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError):
        # Printed so a typo in displayTimezone shows up in CloudWatch rather
        # than as mails that are quietly still in UTC.
        print("DISPLAY_TIMEZONE %r not found; alert emails fall back to UTC" % name)
        return timezone.utc


DISPLAY_ZONE = _display_zone()


def _zone_label(local):
    """"AEST" where the zone has a real abbreviation, else "UTC+06:00".

    Many tz database zones abbreviate to a bare offset like "+06", which reads
    as noise in a mail, so those are spelled out as an offset from UTC.
    """
    abbrev = local.strftime("%Z")
    if abbrev and abbrev[0] not in "+-" and not abbrev.isdigit():
        return abbrev
    offset = local.strftime("%z")  # "+0600"
    if not offset:
        return "UTC"
    return "UTC%s:%s" % (offset[:3], offset[3:5])


def human_time(value):
    """An ISO8601 string (or datetime) as "08 Sep 2026, 14:02 AEST".

    Rendered in DISPLAY_ZONE and always labelled with it, so the mail never
    reads as a bare wall-clock time.

    Minute precision: the duration beside it carries the real resolution.
    Falls back to the raw value if it will not parse - an ugly timestamp in the
    mail beats a mail that never sends - and None when there is nothing to
    format, which drops the row that would have held it.
    """
    if not value:
        return None
    if isinstance(value, datetime):
        parsed = value
    else:
        try:
            parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        except ValueError:
            return str(value)
    # A naive value is UTC by this codebase's convention; without this,
    # astimezone() would treat it as the Lambda host's local time.
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    local = parsed.astimezone(DISPLAY_ZONE)
    return "%s %s" % (local.strftime("%d %b %Y, %H:%M"), _zone_label(local))


def _plural(count, unit):
    return "%d %s%s" % (count, unit, "" if count == 1 else "s")


def human_duration(seconds):
    """Seconds as prose: "45 seconds", "13 minutes", "2 hours 11 minutes".

    Rounded to the nearest whole unit rather than truncated, so it agrees with
    the two minute-precision timestamps in the rows around it. None for
    anything unusable, which drops the "(down for ...)" clause entirely.
    """
    try:
        total = int(seconds)
    except (TypeError, ValueError):
        return None
    if total < 0:
        return None
    # A zero duration means the two timestamps were identical, which in
    # practice means close_incident could not parse one of them. "down for 0
    # seconds" states that as fact; dropping the clause does not.
    if total == 0:
        return None
    if total < 60:
        return _plural(total, "second")

    # int(x + 0.5), not round(): round() is banker's rounding, which sends both
    # 90s and 150s to "2 minutes". Each unit can round up into the next one, so
    # every branch below catches its own overflow - without this, 3599s renders
    # as "60 minutes" rather than "1 hour".
    if total < 3600:
        minutes = int(total / 60.0 + 0.5)
        if minutes == 60:
            return _plural(1, "hour")
        return _plural(minutes, "minute")

    if total < 86400:
        hours, rem = total // 3600, total % 3600
        minutes = int(rem / 60.0 + 0.5)
        if minutes == 60:
            hours, minutes = hours + 1, 0
        if hours >= 24:
            return _plural(1, "day")
        if minutes:
            return "%s %s" % (_plural(hours, "hour"), _plural(minutes, "minute"))
        return _plural(hours, "hour")

    days, rem = total // 86400, total % 86400
    hours = int(rem / 3600.0 + 0.5)
    if hours == 24:
        days, hours = days + 1, 0
    if hours:
        return "%s %s" % (_plural(days, "day"), _plural(hours, "hour"))
    return _plural(days, "day")


def resolved_value(resolved, duration):
    """"09 Sep 2026, 04:12 AEST (down for 13 minutes)" - duration optional."""
    if not resolved:
        return None
    if duration:
        return "%s (down for %s)" % (resolved, duration)
    return resolved


# ----------------------------------------------------------------------------
# Field collection
#
# One list drives both renderings, so the HTML table and the text block cannot
# drift on which fields exist or what order they come in. Each entry is
# (label, text_value, html_value); a falsy value drops the whole row.
# ----------------------------------------------------------------------------
def _field(label, value, html_value=None):
    if not value:
        return None
    return (label, value, html_value if html_value is not None else escape(value))


def _collect(*fields):
    return [f for f in fields if f is not None]


# ----------------------------------------------------------------------------
# HTML fragments
#
# Every table carries role="presentation" so a screen reader announces the
# content rather than "table, 5 rows", plus explicit cellpadding, cellspacing
# and border attributes and border-collapse - that combination is what stops
# Outlook adding spacing of its own around the cells.
# ----------------------------------------------------------------------------
def _table_open(extra_style=""):
    return (
        '<table role="presentation" cellpadding="0" cellspacing="0" border="0"'
        ' style="border-collapse:collapse;%s">' % extra_style
    )


def _field_table(fields):
    """The label/value table. The last row loses its rule so the block ends flush."""
    rows = []
    for index, (label, _, html_value) in enumerate(fields):
        border = "" if index == len(fields) - 1 else "border-bottom:1px solid %s;" % RULE
        rows.append(
            "<tr>"
            # The label column width is set as an attribute as well as in the
            # style: Outlook honours the attribute and ignores the CSS width.
            '<td width="34%%" valign="top" style="width:34%%;'
            "padding:13px 16px 13px 0;%s background-color:%s;"
            "font-family:Helvetica,Arial,sans-serif;font-size:11px;line-height:16px;"
            "letter-spacing:0.08em;text-transform:uppercase;color:%s;"
            'vertical-align:top;">%s</td>'
            '<td valign="top" style="padding:13px 0;%s background-color:%s;'
            "font-family:Helvetica,Arial,sans-serif;font-size:14px;line-height:21px;"
            'color:%s;vertical-align:top;word-break:break-word;">%s</td>'
            "</tr>"
            % (
                border,
                CARD_BG,
                LABEL_FG,
                escape(label),
                border,
                CARD_BG,
                VALUE_FG,
                html_value,
            )
        )
    return _table_open("width:100%;") + "".join(rows) + "</table>"


def _button(url, color):
    """Bulletproof button: colour and padding on the <td>, never on the <a>.

    Outlook drops padding and border-radius set on an anchor, which would leave
    a bare underlined link where the button should be. Painting the cell
    instead costs only the rounded corners there.
    """
    return (
        _table_open()
        + (
            '<tr><td align="center" bgcolor="%s" style="background-color:%s;'
            "padding:14px 38px;border-radius:6px;"
            'mso-padding-alt:14px 38px;">'
            '<a href="%s" target="_blank" style="display:block;'
            "font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:20px;"
            'font-weight:bold;color:#ffffff;text-decoration:none;">View details</a>'
            "</td></tr></table>"
        )
        % (color, color, escape(url, quote=True))
    )


def _url_link(url):
    return '<a href="%s" style="color:%s;text-decoration:underline;">%s</a>' % (
        escape(url, quote=True),
        LINK_FG,
        escape(url),
    )


def _shell(status_word, color, headline, fields, details_url):
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
        ' width="100%%" style="border-collapse:collapse;'
        'background-color:%(page_bg)s;">'
        '<tr><td align="center">'
        '<table role="presentation" cellpadding="0" cellspacing="0" border="0"'
        ' width="600" style="border-collapse:collapse;width:100%%;max-width:600px;'
        "background-color:%(card_bg)s;border-radius:10px;overflow:hidden;"
        'border:1px solid %(rule)s;">'
        # Banner
        '<tr><td style="background-color:%(color)s;padding:18px 32px;">'
        '<table role="presentation" cellpadding="0" cellspacing="0" border="0"'
        ' width="100%%" style="border-collapse:collapse;"><tr>'
        '<td align="left" style="font-family:Helvetica,Arial,sans-serif;'
        'font-size:17px;font-weight:bold;letter-spacing:0.02em;color:#ffffff;">'
        "MuBWeM</td>"
        '<td align="right" style="font-family:Helvetica,Arial,sans-serif;'
        'font-size:11px;font-weight:bold;letter-spacing:0.12em;color:#ffffff;">'
        "%(status_word)s</td>"
        "</tr></table></td></tr>"
        # Headline
        '<tr><td style="padding:30px 32px 0 32px;background-color:%(card_bg)s;'
        "font-family:Helvetica,Arial,sans-serif;font-size:21px;line-height:29px;"
        'font-weight:bold;color:%(value_fg)s;">%(headline)s</td></tr>'
        # Field table
        '<tr><td style="padding:12px 32px 0 32px;background-color:%(card_bg)s;">'
        "%(fields)s</td></tr>"
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
        "fields": _field_table(fields),
        "button": button_block,
        "value_fg": VALUE_FG,
        "muted": MUTED_FG,
        "footer": escape(FOOTER_NOTE),
        "preheader": escape(headline),
    }


def _text(headline, fields, details_url):
    """Plain-text twin. SNS appends its own unsubscribe block below this."""
    width = max(len(label) for label, _, _ in fields)
    lines = [headline.upper(), ""]
    lines += ["  %-*s   %s" % (width, label, value) for label, value, _ in fields]
    if details_url:
        lines += ["", "View details (sign-in required):", "  " + details_url]
    lines += ["", "--", FOOTER_NOTE]
    return "\n".join(lines)


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
    details = ctx.get("details_url") or ""

    fields = _collect(
        _field("Monitor", name),
        _field("URL", url, _url_link(url) if url else None),
        _field("Root cause", ctx.get("root_cause")),
        _field("Incident started", human_time(ctx.get("started_at"))),
        _field("Location", region_label(ctx.get("location"))),
    )
    headline = "%s is down" % name

    return (
        "[MuBWeM] DOWN - %s" % name,
        _text(headline, fields, details),
        _shell("DOWN", DOWN_COLOR, headline, fields, details),
    )


def render_recovered(ctx):
    """Return (subject, text_body, html_body) for an incident that just closed.

    Downtime rides along with the resolved time rather than claiming a row of
    its own - it is derived from the two timestamps already on screen.
    """
    name = ctx.get("name") or ctx.get("siteId") or "Monitor"
    url = ctx.get("url") or ""
    details = ctx.get("details_url") or ""

    fields = _collect(
        _field("Monitor", name),
        _field("URL", url, _url_link(url) if url else None),
        _field("Root cause", ctx.get("root_cause")),
        _field("Incident started", human_time(ctx.get("started_at"))),
        _field(
            "Resolved at",
            resolved_value(
                human_time(ctx.get("resolved_at")),
                human_duration(ctx.get("duration_sec")),
            ),
        ),
        _field("Location", region_label(ctx.get("location"))),
    )
    headline = "%s is back up" % name

    return (
        "[MuBWeM] RESOLVED - %s" % name,
        _text(headline, fields, details),
        _shell("RESOLVED", UP_COLOR, headline, fields, details),
    )
