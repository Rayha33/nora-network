"""One icon per asset type: a coloured disc with a white glyph, shared by both views.

The flow overview uses them as pyvis node images and the map as MapLibre symbols, so an
asset looks the same wherever it appears. Add a type here when you add one to data.py.
"""

from __future__ import annotations

from urllib.parse import quote

COLORS = {
    "field": "#2d7a55",
    "hub": "#3b4a57",
    "processing": "#6b4e9b",
    "terminal": "#1f69a0",
    "lng": "#b5730f",
    "storage": "#7a5a2c",
    "market": "#1d2731",
}

# White glyphs drawn on a 48 x 48 canvas.
GLYPHS = {
    # a gas flame
    "field": '<path fill="#fff" d="M24 10c4 6 9 9.5 9 16.5a9 9 0 0 1-18 0c0-4 2.4-6.6 4-9 '
    '.2 3.4 1.6 5 3.6 6 .2-5-1.2-9 1.4-13.5z"/>',
    # an offshore platform: deck, derrick and legs
    "hub": '<g fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" '
    'stroke-linejoin="round"><path d="M13 22h22M16 22l-2.5 13M32 22l2.5 13M24 22v13'
    'M19.5 22l4.5-10 4.5 10"/></g>',
    # a plant with a chimney
    "processing": '<path fill="#fff" d="M12 35V23l7 4.2V23l7 4.2V23l7 4.2V12h4v23z"/>',
    # gas arriving into a terminal
    "terminal": '<g fill="none" stroke="#fff" stroke-width="2.8" stroke-linecap="round" '
    'stroke-linejoin="round"><path d="M24 11v15M17.5 20l6.5 6.5 6.5-6.5M13 28v6h22v-6"/></g>',
    # a snowflake: liquefied natural gas
    "lng": '<g fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round">'
    '<path d="M24 11v26M12.7 17.5l22.6 13M12.7 30.5l22.6-13M20.5 12.5 24 16l3.5-3.5'
    'M20.5 35.5 24 32l3.5 3.5"/></g>',
    # a storage tank
    "storage": '<g fill="none" stroke="#fff" stroke-width="2.6"><ellipse cx="24" cy="15" '
    'rx="10" ry="4"/><path d="M14 15v17c0 2.2 4.5 4 10 4s10-1.8 10-4V15M14 23.5c0 2.2 '
    '4.5 4 10 4s10-1.8 10-4"/></g>',
    # a market hall
    "market": '<g fill="#fff"><path d="M11 20 24 12l13 8z"/><rect x="11" y="33" width="26" '
    'height="3" rx="1"/><rect x="14" y="22" width="3" height="10"/><rect x="22.5" y="22" '
    'width="3" height="10"/><rect x="31" y="22" width="3" height="10"/></g>',
}


def icon_svg(kind: str) -> str:
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48">'
        f'<circle cx="24" cy="24" r="22.5" fill="{COLORS[kind]}" stroke="#fff" '
        f'stroke-width="2"/>{GLYPHS[kind]}</svg>'
    )


def icon_uri(kind: str) -> str:
    return "data:image/svg+xml;charset=utf-8," + quote(icon_svg(kind))
