declare module "qrcode/lib/browser" {
  export function toCanvas(
    canvas: HTMLCanvasElement,
    text: string,
    options: {
      width: number;
      margin: number;
      errorCorrectionLevel: "M";
      color: { dark: string; light: string };
    },
  ): Promise<void>;
}
