#!/usr/bin/env python3
"""
Build epg_merged.xml for russia_sorted.m3u.

Downloads a public Russian XMLTV guide, maps its channels onto the playlist's
tvg-ids, trims to today onward, and writes epg_merged.xml.

Stdlib only. Runs in GitHub Actions (see .github/workflows/update-epg.yml).

Notes on sources:
  * epg.one  -> primary. Numeric ids, clean display-names, good RU coverage.
  * iptvx.one-> fallback fill for channels epg.one publishes without a schedule
                (notably Солнце / Solnce). Streamed, since it is ~180MB.

The output uses the PLAYLIST's tvg-id values as <channel id>, so the guide
matches the M3U with no manual mapping in the player.
"""

import gzip
import io
import re
import sys
import urllib.request
from datetime import datetime, timedelta, timezone

EPG_PRIMARY = "https://epg.one/epg.xml.gz"
EPG_FALLBACK = "https://iptvx.one/epg/epg_lite.xml.gz"

OUT_XML = "epg_merged.xml"
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)

# our tvg-id -> candidate display names, in priority order.
# Keep this list in sync with the top block of russia_sorted.m3u.
WANT = {
    "ChannelOne.ru": ["Первый канал", "Первый"],
    "Russia1.ru": ["Россия 1"],
    "NTV.ru": ["НТВ"],
    "Channel5.ru": ["Пятый канал"],
    "RussiaK.ru": ["Россия К", "Россия Культура", "Культура"],
    "Russia24.ru": ["Россия 24"],
    "Carousel.ru": ["Карусель"],
    "OTR.ru": ["ОТР"],
    "TVCentr.ru": ["ТВ Центр"],
    "RENTV.ru": ["РЕН ТВ"],
    "Spas.ru": ["Спас"],
    "STS.ru": ["СТС"],
    "Domashniy.ru": ["Домашний"],
    "TV3.ru": ["ТВ3", "ТВ-3"],
    "Friday.ru": ["Пятница!", "Пятница"],
    "Zvezda.ru": ["Звезда"],
    "Mir.ru": ["Мир"],
    "TNT.ru": ["ТНТ"],
    "MuzTV.ru": ["Муз-ТВ", "Муз ТВ"],
    "Che.ru": ["Че!", "Че"],
    "RBKTV.ru": ["РБК"],
    "KHL.ru": ["КХЛ"],
    "TNT4.ru": ["ТНТ4"],
    "2x2.ru": ["2x2", "2х2"],
    "Solnce.ru": ["Солнце"],
    "Subbota.ru": ["Суббота!", "Суббота"],
    "U.ru": ["Ю ТВ"],
    "Russkiyroman.ru": ["Русский роман"],
    "STSLove.ru": ["СТС Love"],
    "Mir24.ru": ["Мир 24"],
    "O.ru": ["О!", "О"],
    "KVNTV.ru": ["КВН ТВ", "КВН"],
    "Nostalgia.ru": ["Ностальгия"],
    "DiscoveryChannel.ru": ["Discovery Channel", "Discovery"],
    "NationalGeographic.ru": ["National Geographic", "Nat Geo"],
    "AnimalPlanet.ru": ["Animal Planet"],
    "TLC.ru": ["TLC"],
    "vijuTV1000.ru": ["TV1000", "Viasat TV1000", "viju TV1000"],
    "Kinopokaz.ru": ["Кинопоказ"],
    "Domkino.ru": ["Дом кино", "Дом Кино"],
    "MoyaPlaneta.ru": ["Моя планета"],
    "Nauka.ru": ["Наука"],
    "Telecafe.ru": ["Телекафе"],
    "Mult.ru": ["Мульт"],
    "Nickelodeon.ru": ["Nickelodeon"],
    "EuropaPlusTV.ru": ["Europa Plus TV"],
    "Retro.ru": ["Ретро"],
    "Kuhnya.ru": ["Кухня ТВ", "Кухня"],
    "Evrokino.ru": ["Еврокино"],
    "Match.ru": ["Матч ТВ", "Матч!", "Матч"],
    # Матч! Ультра is published by no source; Арена is the nearest sports feed.
    "MatchUltra.ru": ["Матч! Арена"],
    "Pobeda.ru": ["Победа"],
    "Izvestia.ru": ["Известия"],
}

# channels epg.one has no schedule for -> id in the fallback guide
FALLBACK_IDS = {"Solnce.ru": "solnce"}

_Q_SUFFIX = re.compile(r"\s*(hd|fhd|uhd|4k|orig)\s*$", re.I)
_SHIFT_PAREN = re.compile(r"\s*\(\+\d+\)\s*$")
_SHIFT_PLUS = re.compile(r"\s*\+\d+\s*(\(.*\))?\s*$")
_PAREN = re.compile(r"\s*\([^)]*\)\s*$")


def norm(name: str) -> str:
    """Normalise a display-name so regional/quality/shifted variants collapse."""
    s = name.lower()
    s = _Q_SUFFIX.sub("", s)
    s = _SHIFT_PAREN.sub("", s)
    s = _SHIFT_PLUS.sub("", s)
    s = _PAREN.sub("", s)
    return s.strip()


def fetch(url: str, timeout: int = 240) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read()
    if raw[:2] == b"\x1f\x8b":
        raw = gzip.decompress(raw)
    return raw.decode("utf-8", errors="replace")


CHANNEL_RE = re.compile(r'<channel id="([^"]+)"[^>]*>(.*?)</channel>', re.S)
DISPLAY_RE = re.compile(r"<display-name[^>]*>([^<]+)</display-name>")
ICON_RE = re.compile(r"<icon[^>]*>")
PROG_RE = re.compile(r'<programme\b[^>]*channel="([^"]+)"[^>]*>.*?</programme>', re.S)
START_RE = re.compile(r'start="(\d{12})')


def parse_channels(xml: str):
    out = []
    for m in CHANNEL_RE.finditer(xml):
        body = m.group(2)
        out.append(
            {
                "id": m.group(1),
                "names": [n.strip() for n in DISPLAY_RE.findall(body)],
                "icon": (ICON_RE.search(body).group(0) if ICON_RE.search(body) else ""),
            }
        )
    return out


def build_index(channels):
    """Map normalised name -> (channel, score). Plain names beat HD/shift variants."""
    idx = {}
    for ch in channels:
        for n in ch["names"]:
            k = norm(n)
            if not k:
                continue
            score = 1 if (
                _Q_SUFFIX.search(n) or "+" in n or "(" in n
            ) else 0
            prev = idx.get(k)
            if prev is None or score < prev[1]:
                idx[k] = (ch, score)
    return idx


def main() -> int:
    print(f"downloading {EPG_PRIMARY} ...")
    xml = fetch(EPG_PRIMARY)
    print(f"  {len(xml) / 1e6:.1f} MB")

    channels = parse_channels(xml)
    idx = build_index(channels)
    print(f"  {len(channels)} channels in source")

    mapping = {}
    reverse = {}
    for ours, names in WANT.items():
        hit = None
        for n in names:
            e = idx.get(norm(n))
            if e and e[0]["id"] not in reverse:
                hit = e[0]
                break
        mapping[ours] = hit["id"] if hit else None
        if hit:
            reverse[hit["id"]] = ours

    mapped = sum(1 for v in mapping.values() if v)
    print(f"mapped {mapped}/{len(WANT)}")
    for k, v in mapping.items():
        if not v:
            print(f"  !! unmapped: {k}")

    # trim to today 00:00 Moscow (UTC+3)
    msk = datetime.now(timezone.utc) + timedelta(hours=3)
    cut = msk.strftime("%Y%m%d") + "000000"
    print(f"cutoff (today 00:00 MSK): {cut}")

    out_ch = []
    for epg_id, ours in reverse.items():
        ch = next(c for c in channels if c["id"] == epg_id)
        lines = [f'  <channel id="{ours}">']
        for n in ch["names"]:
            lines.append(f"    <display-name>{n}</display-name>")
        if ch["icon"]:
            lines.append(f"    {ch['icon']}")
        lines.append("  </channel>")
        out_ch.append("\n".join(lines))

    out_pr = []
    for m in PROG_RE.finditer(xml):
        ours = reverse.get(m.group(1))
        if not ours:
            continue
        st = START_RE.search(m.group(0))
        if not st or st.group(1) < cut:
            continue
        out_pr.append(
            "  " + re.sub(r'channel="[^"]+"', f'channel="{ours}"', m.group(0), count=1)
        )

    # fallback fill for channels with no schedule upstream
    have = set(re.findall(r'channel="([^"]+)"', "\n".join(out_pr)))
    missing = [ours for ours in reverse.values() if ours not in have]
    if missing:
        print(f"  no schedule for: {', '.join(missing)} -> trying fallback")
        try:
            fb = fetch(EPG_FALLBACK)
            for ours in missing:
                src_id = FALLBACK_IDS.get(ours)
                if not src_id:
                    print(f"    !! no fallback id for {ours}")
                    continue
                rx = re.compile(
                    r'<programme\b[^>]*channel="' + re.escape(src_id) + r'"[^>]*>.*?</programme>',
                    re.S,
                )
                got = 0
                for g in rx.finditer(fb):
                    st = START_RE.search(g.group(0))
                    if st and st.group(1) < cut:
                        continue
                    out_pr.append(
                        "  " + re.sub(r'channel="[^"]+"', f'channel="{ours}"', g.group(0), count=1)
                    )
                    got += 1
                print(f"    {ours} <- {got} programmes from fallback")
        except Exception as exc:  # noqa: BLE001
            print(f"    fallback failed: {exc}")

    # sort programmes by channel then start (nice for diffs)
    def key(p):
        ch = (re.search(r'channel="([^"]+)"', p) or [None, ""])[1]
        st = START_RE.search(p)
        return (ch, st.group(1) if st else "")

    out_pr.sort(key=key)

    head = (
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<!DOCTYPE tv SYSTEM "xmltv.dtd">\n'
        '<tv generator-info-name="dakafunf5-epg">'
    )
    doc = "\n".join([head, *out_ch, *out_pr, "</tv>", ""])
    with open(OUT_XML, "w", encoding="utf-8") as fh:
        fh.write(doc)

    days = sorted({(START_RE.search(p).group(1)[:8]) for p in out_pr if START_RE.search(p)})
    print(f"wrote {OUT_XML}: channels {len(out_ch)}, programmes {len(out_pr)}")
    print(f"  range {days[0]} -> {days[-1]}" if days else "  no programmes!")

    if not out_pr:
        print("ERROR: no programmes produced", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
