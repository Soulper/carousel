"""
Cutout prep for the carousel template.
For each sourced image: background removal -> clean mask -> subject bbox
-> optional white-outlined sticker. Writes a JSON patch for the slot.

  pip install "rembg[cpu]" opencv-python-headless pillow numpy
  python prepare_cutouts.py hero.jpg helmet.jpg --sticker helmet.jpg
"""
import argparse, json, os
import numpy as np, cv2
from PIL import Image
from rembg import remove, new_session

SESSION = new_session("isnet-general-use")  # load once per worker


def cutout(path):
    src = Image.open(path).convert("RGB")
    rgba = np.array(remove(src, session=SESSION, post_process_mask=True))
    a = rgba[..., 3]
    # keep the largest subject only (drops stray fragments)
    n, lab, st, _ = cv2.connectedComponentsWithStats((a > 40).astype(np.uint8))
    if n < 2:
        return None
    big = 1 + np.argmax(st[1:, 4])
    rgba[..., 3] = np.where(lab == big, a, 0)
    ys, xs = np.where(rgba[..., 3] > 128)
    h, w = a.shape
    area = len(xs) / (w * h)
    box = [round(xs.min() / w * 100, 1), round(ys.min() / h * 100, 1),
           round(xs.max() / w * 100, 1), round(ys.max() / h * 100, 1)]
    # QA: subject should be a sensible share of the frame and not a sliver
    ok = 0.08 < area < 0.85 and (box[2] - box[0]) > 15
    out = os.path.splitext(path)[0] + "_cut.webp"
    Image.fromarray(rgba).save(out, quality=88)  # same dimensions as source = pixel-aligned
    return {"cutout": out, "cutoutBox": box, "subjectArea": round(area, 3), "cutoutOk": ok}


def sticker(cut_path, stroke=12, pad=30):
    im = Image.open(cut_path)
    a = np.array(im)[..., 3]
    ys, xs = np.where(a > 40)
    crop = im.crop((xs.min(), ys.min(), xs.max() + 1, ys.max() + 1))
    canvas = Image.new("RGBA", (crop.width + 2 * pad, crop.height + 2 * pad), (0, 0, 0, 0))
    canvas.paste(crop, (pad, pad), crop)
    al = (np.array(canvas)[..., 3] > 100).astype(np.uint8) * 255
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (stroke * 2 + 1, stroke * 2 + 1))
    ring = cv2.GaussianBlur(cv2.dilate(al, k), (3, 3), 0)
    white = Image.new("RGBA", canvas.size, (255, 255, 255, 0))
    white.putalpha(Image.fromarray(ring))
    white.alpha_composite(canvas)
    out = cut_path.replace("_cut.webp", "_sticker.webp")
    white.save(out, quality=88)
    return out


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("images", nargs="+")
    ap.add_argument("--sticker", nargs="*", default=[])
    args = ap.parse_args()
    result = {}
    for p in args.images:
        r = cutout(p)
        if r and p in args.sticker and r["cutoutOk"]:
            r["sticker"] = sticker(r["cutout"])
        result[p] = r
    print(json.dumps(result, indent=2))
