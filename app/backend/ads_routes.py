"""
Ad Studio backend — the product-link half of Higgsfield's Click-to-Ad.

POST /api/ads/scrape   {url} -> {title, description, price, brand, images[], url}
GET  /api/ads/image    ?u=<image url> -> proxied image bytes (browsers can't fetch
                         arbitrary product images cross-origin; the backend does)

Only public http(s) hosts are fetched: loopback / private / link-local targets are
refused, because this backend is reachable from the LAN and from any web page the
user visits (CORS is open), so an unguarded fetch would be an SSRF gadget.
"""

import ipaddress
import json
import re
import socket
from html import unescape
from urllib.parse import urljoin, urlparse

import httpx
from fastapi import Form, HTTPException
from fastapi.responses import Response

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"


def _assert_public(url: str) -> str:
    p = urlparse(url)
    if p.scheme not in ("http", "https") or not p.hostname:
        raise HTTPException(400, "Only http(s) product links are supported")
    try:
        infos = socket.getaddrinfo(p.hostname, p.port or (443 if p.scheme == "https" else 80), proto=socket.IPPROTO_TCP)
    except socket.gaierror:
        raise HTTPException(400, f"Cannot resolve {p.hostname}")
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast:
            raise HTTPException(400, "That address is not a public website")
    return url


def _meta(html: str, *names: str) -> str:
    for n in names:
        m = re.search(rf'<meta[^>]+(?:property|name)=["\']{re.escape(n)}["\'][^>]*content=["\']([^"\']*)["\']', html, re.I) or \
            re.search(rf'<meta[^>]+content=["\']([^"\']*)["\'][^>]*(?:property|name)=["\']{re.escape(n)}["\']', html, re.I)
        if m and m.group(1).strip():
            return unescape(m.group(1).strip())
    return ""


def _ld_products(html: str) -> list[dict]:
    out = []
    for blob in re.findall(r'<script[^>]+type=["\']application/ld\+json["\'][^>]*>(.*?)</script>', html, re.I | re.S):
        try:
            data = json.loads(blob.strip())
        except Exception:
            continue
        stack = data if isinstance(data, list) else [data]
        while stack:
            d = stack.pop()
            if isinstance(d, dict):
                if "@graph" in d:
                    stack.extend(d["@graph"])
                t = d.get("@type")
                if t == "Product" or (isinstance(t, list) and "Product" in t):
                    out.append(d)
    return out


def register(app, m):
    @app.post("/api/ads/scrape")
    async def scrape(url: str = Form(...)):
        url = url.strip()
        if not re.match(r"^https?://", url, re.I):
            url = "https://" + url
        _assert_public(url)
        async with httpx.AsyncClient(timeout=20, follow_redirects=True, headers={"User-Agent": UA}, trust_env=False) as c:
            try:
                r = await c.get(url)
            except httpx.HTTPError as e:
                raise HTTPException(502, f"Could not load the page: {e}")
            _assert_public(str(r.url))  # post-redirect check
        if r.status_code >= 400:
            raise HTTPException(502, f"The site answered {r.status_code}")
        html = r.text[:2_000_000]
        title = _meta(html, "og:title", "twitter:title") or (re.search(r"<title[^>]*>(.*?)</title>", html, re.I | re.S).group(1).strip() if re.search(r"<title", html, re.I) else "")
        desc = _meta(html, "og:description", "description", "twitter:description")
        price, brand, images = "", _meta(html, "og:site_name"), []
        for p in _ld_products(html):
            title = title or p.get("name", "")
            desc = desc or p.get("description", "")
            b = p.get("brand")
            brand = (b.get("name") if isinstance(b, dict) else b) or brand
            offers = p.get("offers")
            offers = offers[0] if isinstance(offers, list) and offers else offers
            if isinstance(offers, dict) and offers.get("price"):
                price = f"{offers.get('priceCurrency', '')} {offers['price']}".strip()
            img = p.get("image")
            for i in ([img] if isinstance(img, str) else img or []):
                images.append(i if isinstance(i, str) else i.get("url", ""))
        og = _meta(html, "og:image", "twitter:image")
        if og:
            images.insert(0, og)
        for src in re.findall(r'<img[^>]+(?:src|data-src)=["\']([^"\']+)["\']', html, re.I)[:60]:
            if re.search(r"\.(jpe?g|png|webp)(\?|$)", src, re.I) and not re.search(r"sprite|icon|logo|pixel|tracking|avatar", src, re.I):
                images.append(src)
        seen, uniq = set(), []
        for i in images:
            full = urljoin(str(r.url), unescape(i))
            if full and full not in seen and full.startswith("http"):
                seen.add(full)
                uniq.append(full)
        return {"url": str(r.url), "title": unescape(title)[:200], "description": desc[:600], "price": price,
                "brand": unescape(brand or "")[:80], "images": uniq[:16]}

    @app.get("/api/ads/image")
    async def proxy_image(u: str):
        _assert_public(u)
        async with httpx.AsyncClient(timeout=20, follow_redirects=True, headers={"User-Agent": UA}, trust_env=False) as c:
            r = await c.get(u)
            _assert_public(str(r.url))
        ct = r.headers.get("content-type", "")
        if r.status_code >= 400 or not ct.startswith("image/") or len(r.content) > 15_000_000:
            raise HTTPException(502, "Not a usable image")
        return Response(content=r.content, media_type=ct)
