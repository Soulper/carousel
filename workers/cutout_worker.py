"""
Cutout worker — fills in subject cutouts for stories, then marks them ready.

Picks up stories in status 'draft' whose cover has a main image but no cutout,
runs background removal, uploads results to the `studio` bucket, writes
cutout / cutoutBox / sticker back into the story's slides and sets status 'ready'.

  pip install "rembg[cpu]" opencv-python-headless pillow numpy supabase requests
  SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... python cutout_worker.py          # loop
  SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... python cutout_worker.py --once   # single pass

Runs anywhere with Python (a small VPS, Railway, Fly) — not on Vercel.
"""
import io, os, sys, time, tempfile
import requests
from supabase import create_client
from prepare_cutouts import cutout, sticker

sb = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_ROLE_KEY"])
BUCKET = "studio"


def fetch(url, folder):
    r = requests.get(url, timeout=30, headers={"User-Agent": "Mozilla/5.0"})
    r.raise_for_status()
    ext = os.path.splitext(url.split("?")[0])[1][:5] or ".jpg"
    path = os.path.join(folder, "src" + ext)
    with open(path, "wb") as f:
        f.write(r.content)
    return path


def put(local, story_id, name):
    key = f"cutouts/{story_id}/{int(time.time())}-{name}"
    with open(local, "rb") as f:
        sb.storage.from_(BUCKET).upload(key, f.read(), {"content-type": "image/webp"})
    return sb.storage.from_(BUCKET).get_public_url(key)


def process(story):
    slides = story["slides"]
    cover = slides[0] if slides and slides[0].get("layout") == "cover" else None
    if not cover:
        return False
    changed = False
    with tempfile.TemporaryDirectory() as tmp:
        bg = cover.get("bg") or {}
        if bg.get("src") and not bg.get("cutout"):
            r = cutout(fetch(bg["src"], tmp))
            if r and r["cutoutOk"]:
                bg["cutout"] = put(r["cutout"], story["id"], "bg_cut.webp")
                bg["cutoutBox"] = r["cutoutBox"]
                changed = True
        inset = cover.get("inset") or {}
        if inset.get("src") and not inset.get("cutout"):
            d = os.path.join(tmp, "inset"); os.makedirs(d)
            r = cutout(fetch(inset["src"], d))
            if r and r["cutoutOk"]:
                inset["cutout"] = put(r["cutout"], story["id"], "inset_cut.webp")
                st = cover.setdefault("sticker", {"x": 3, "y": 3, "width": 44, "rotate": -7})
                if not st.get("src"):
                    st["src"] = put(sticker(r["cutout"]), story["id"], "inset_sticker.webp")
                changed = True
        cover["bg"], cover["inset"] = bg, inset
    if changed:
        sb.table("stories").update({"slides": slides, "status": "ready"}).eq("id", story["id"]).execute()
    return changed


def tick():
    rows = sb.table("stories").select("id, slides").eq("status", "draft").limit(20).execute().data
    for s in rows:
        try:
            print(s["id"], "cutouts added" if process(s) else "nothing to cut", flush=True)
        except Exception as e:  # leave it in draft so it can be retried or fixed by hand
            print(s["id"], "failed:", e, flush=True)


if __name__ == "__main__":
    if "--once" in sys.argv:
        tick()
    else:
        while True:
            tick()
            time.sleep(20)
