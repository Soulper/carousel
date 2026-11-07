// Starting slides for a new story (and the brand editor preview when a page has no stories yet)
export const blankSlides = () => [
  {
    layout: "cover",
    headline: "Your headline goes here and wraps to fit",
    bg: { src: "", cutout: "", focal: [50, 35] },
    inset: { src: "", cutout: "", focal: [50, 35] },
    sticker: { src: "", x: 3, y: 3, width: 44, rotate: -7 },
  },
  {
    layout: "body",
    title: "Slide title",
    body: "Body copy with a [[highlighted phrase]] in the middle of it.",
    bg: { src: "", focal: [50, 40] },
  },
];

/* True when a text field is empty OR still one of the blank-slide placeholders.
   "Write words" must treat a fresh story as unwritten, not as already done. */
export const isBlankText = (t) => {
  const s = (t || "").trim();
  if (!s) return true;
  return /^(your headline goes here|slide title|body copy with a)/i.test(s);
};
