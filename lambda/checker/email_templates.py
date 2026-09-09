"""Alert email rendering for the MuBWeM checker.

Two mails, one shape: a status banner, a headline, one or two sentences
saying what happened and when, the monitored URL, and a "View details"
button onto that monitor's page in the dashboard.

  DOWN       "Went down <time> - <cause>."
  RECOVERED  the same line, plus "Back up <time>, after <duration> down."

The layout is deliberately prose rather than a label/value field table. An
alert is read in two seconds on a phone, and a sentence survives that better
than five rows of which four are the same every time. The region the check ran
from is real but secondary, so it sits in the footer rather than competing
with the cause.

Everything is inline-styled, table-based and 600px wide because that is the
only layout email clients agree on: no stylesheet, no webfont, no external
image, no flexbox. Every cell carries an explicit background colour so a
dark-mode client cannot invert the card into grey-on-grey.

Each render also returns a plain-text alternative. SES sends both parts, which
is what keeps the mail readable in a text-only client - and it is the body the
checker falls back to when it has to publish through SNS instead. SNS appends
its own unsubscribe footer below that body; everything above it is ours.

Every clause is optional. Incidents opened before rootCause and region existed
carry neither, so a missing value drops its clause rather than printing a
placeholder - "Went down 09 Sep 2026, 03:59 UTC." is a whole sentence, and
that is the degraded form.

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
BODY_FG = "#374151"
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

# What CHECK_REGION falls back to when the stack never set it. Not a region,
# so it must not be rendered as one.
UNKNOWN_REGION = "unknown"

# Written as an escape, not a literal, so the shipped source file stays pure
# ASCII - Code.from_asset zips this directory verbatim.
EM_DASH = "\u2014"


# ----------------------------------------------------------------------------
# Display formatting
#
# None of this touches a stored value. The ISO8601 strings written to DynamoDB
# are sort keys shared with the API and the seed script; they are formatted for
# a human here and nowhere else.
# ----------------------------------------------------------------------------
def region_label(code):
    """Turn a region code into "Sydney, Australia (ap-southeast-2)".

    None when there is no usable region, so the footer can drop the clause
    rather than claim the check ran from somewhere called "unknown".
    """
    if not code or str(code).strip().lower() == UNKNOWN_REGION:
        return None
    friendly = REGION_LABELS.get(code)
    return "%s (%s)" % (friendly, code) if friendly else str(code)


def human_time(value):
    """An ISO8601 string (or datetime) as "08 Sep 2026, 14:02 UTC".

    Minute precision: the sentence reads better without seconds, and the
    duration clause beside it carries the real resolution. Falls back to the
    raw value if it will not parse - an ugly timestamp in the mail beats a mail
    that never sends - and None when there is nothing to format, which drops
    the clause that would have held it.
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
    return parsed.astimezone(timezone.utc).strftime("%d %b %Y, %H:%M UTC")


def _plural(count, unit):
    return "%d %s%s" % (count, unit, "" if count == 1 else "s")


def human_duration(seconds):
    """Seconds as prose: "45 seconds", "13 minutes", "2 hours 11 minutes".

    Rounded to the nearest whole unit rather than truncated, so it agrees with
    the two minute-precision timestamps printed either side of it. None for
    anything unusable, which drops the "after ... down" clause entirely.
    """
    try:
        total = int(seconds)
    except (TypeError, ValueError):
        return None
    if total < 0:
        return None
    # A zero duration means the two timestamps were identical, which in
    # practice means close_incident could not parse one of them. "after 0
    # seconds down" states that as fact; dropping the clause does not.
    if total == 0:
        return None
    if total < 60:
        return _plural(total, "second")

    # int(x + 0.5), not round(): round() is banker's rounding, which sends both
    # 90s and 150s to "2 minutes". Each unit can round up into the next one,
    # so every branch below has to catch its own overflow - without this, 3599s
    # renders as "60 minutes" rather than "1 hour".
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


# ----------------------------------------------------------------------------
# Sentences
#
# Each clause is dropped when its value is missing, so an incident row written
# before rootCause existed degrades to a shorter true sentence rather than to
# "Unknown" or a dangling dash.
# ----------------------------------------------------------------------------
def went_down_sentence(started, cause):
    text = "Went down %s" % started if started else "Went down"
    if cause:
        text += " %s %s" % (EM_DASH, cause)
    return text + "."


def back_up_sentence(resolved, duration):
    text = "Back up %s" % resolved if resolved else "Back up"
    if duration:
        text += ", after %s down" % duration
    return text + "."


def footer_sentence(location):
    if location:
        return "Sent by MuBWeM, checked from %s." % location
    return "Sent by MuBWeM."


# ----------------------------------------------------------------------------
# HTML fragments
# ----------------------------------------------------------------------------
def _button(url, color):
    """A bulletproof button: padding on the anchor, solid bgcolor underneath."""
    safe = escape(url, quote=True)
    return (
        '<table role="presentation" cellpadding="0" cellspacing="0" border="0">'
        '<tr><td align="center" bgcolor="%s" style="border-radius:6px;">'
        '<a href="%s" target="_blank" style="display:inline-block;'
        "padding:14px 38px;font-family:Helvetica,Arial,sans-serif;font-size:15px;"
        "font-weight:bold;color:#ffffff;text-decoration:none;border-radius:6px;"
        'background-color:%s;">View details</a>'
        "</td></tr></table>"
    ) % (color, safe, color)


def _url_link(url):
    return '<a href="%s" style="color:%s;text-decoration:underline;">%s</a>' % (
        escape(url, quote=True),
        LINK_FG,
        escape(url),
    )


def _shell(status_word, color, headline, sentences, url, details_url, footer_note):
    sentence_html = "".join(
        '<tr><td style="padding:%s 32px 0 32px;background-color:%s;'
        "font-family:Helvetica,Arial,sans-serif;font-size:16px;line-height:25px;"
        'color:%s;word-break:break-word;">%s</td></tr>'
        % ("14" if i == 0 else "4", CARD_BG, BODY_FG, escape(sentence))
        for i, sentence in enumerate(sentences)
    )

    url_html = ""
    if url:
        url_html = (
            '<tr><td style="padding:12px 32px 0 32px;background-color:%s;'
            "font-family:Helvetica,Arial,sans-serif;font-size:14px;line-height:21px;"
            'word-break:break-all;">%s</td></tr>'
        ) % (CARD_BG, _url_link(url))

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
        '<tr><td style="padding:32px 32px 0 32px;background-color:%(card_bg)s;'
        "font-family:Helvetica,Arial,sans-serif;font-size:22px;line-height:30px;"
        'font-weight:bold;color:%(value_fg)s;">%(headline)s</td></tr>'
        "%(sentences)s"
        "%(url)s"
        "%(button)s"
        # Footer
        '<tr><td style="padding:30px 32px 28px 32px;background-color:%(card_bg)s;'
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
        "sentences": sentence_html,
        "url": url_html,
        "button": button_block,
        "value_fg": VALUE_FG,
        "muted": MUTED_FG,
        "footer": escape(footer_note),
        # The first sentence, not the headline - the headline is already most
        # of the subject line, so repeating it wastes the preview.
        "preheader": escape(sentences[0]) if sentences else escape(headline),
    }


def _text(headline, sentences, url, details_url, footer_note):
    """Plain-text twin. SNS appends its own unsubscribe block below this."""
    lines = [headline.upper(), ""]
    lines += sentences
    if url:
        lines += ["", url]
    if details_url:
        lines += ["", "View details (sign-in required):", "  " + details_url]
    lines += ["", "--", footer_note]
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

    headline = "%s is down" % name
    sentences = [
        went_down_sentence(human_time(ctx.get("started_at")), ctx.get("root_cause"))
    ]
    footer = footer_sentence(region_label(ctx.get("location")))

    return (
        "[MuBWeM] DOWN - %s" % name,
        _text(headline, sentences, url, details, footer),
        _shell("DOWN", DOWN_COLOR, headline, sentences, url, details, footer),
    )


def render_recovered(ctx):
    """Return (subject, text_body, html_body) for an incident that just closed.

    Two sentences, not one: a recovery line on its own would drop the cause,
    and what broke is most of why anyone opens a resolved alert at all.
    """
    name = ctx.get("name") or ctx.get("siteId") or "Monitor"
    url = ctx.get("url") or ""
    details = ctx.get("details_url") or ""

    headline = "%s is back up" % name
    sentences = [
        went_down_sentence(human_time(ctx.get("started_at")), ctx.get("root_cause")),
        back_up_sentence(
            human_time(ctx.get("resolved_at")),
            human_duration(ctx.get("duration_sec")),
        ),
    ]
    footer = footer_sentence(region_label(ctx.get("location")))

    return (
        "[MuBWeM] RESOLVED - %s" % name,
        _text(headline, sentences, url, details, footer),
        _shell("RESOLVED", UP_COLOR, headline, sentences, url, details, footer),
    )
