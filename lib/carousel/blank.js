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
