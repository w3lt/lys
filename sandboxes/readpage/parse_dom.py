import sys
from bs4 import BeautifulSoup

html = sys.stdin.read()

if not html.strip():
    raise SystemExit("Error: Chromium returned empty HTML")


soup = BeautifulSoup(html, "html.parser")

for tag in soup.select("script, style, noscript, link, meta"):
    tag.decompose()

for tag in soup.find_all(True):
    for attr in ("style", "class"):
        tag.attrs.pop(attr, None)

print(str(soup))
