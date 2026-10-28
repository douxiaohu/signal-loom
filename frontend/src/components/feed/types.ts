export type FeedDensity = "reading" | "console";

/** What the full-size image viewer needs to open. */
export type OpenImage = {
  alt: string;
  src: string;
};

export type OpenImageHandler = (image: OpenImage, trigger: HTMLButtonElement | null) => void;
