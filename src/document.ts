export type OcrState = "idle" | "processing" | "done" | "error";

export type TextBlock = {
  id: string;
  type: "text";
  text: string;
};

export type ImageBlock = {
  id: string;
  type: "image";
  imageDataUrl: string | null;
  ocrText: string;
  view: "image" | "text";
  ocrState: OcrState;
  elapsedMs: number | null;
  error: string | null;
};

export type DocumentBlock = TextBlock | ImageBlock;

export function createBlockId(): string {
  return crypto.randomUUID();
}

export function createTextBlock(text = ""): TextBlock {
  return { id: createBlockId(), type: "text", text };
}

export function createImageBlock(imageDataUrl: string): ImageBlock {
  return {
    id: createBlockId(),
    type: "image",
    imageDataUrl,
    ocrText: "",
    view: "image",
    ocrState: "processing",
    elapsedMs: null,
    error: null
  };
}

export function getDocumentText(blocks: DocumentBlock[]): string {
  return blocks
    .map((block) => (block.type === "text" ? block.text : block.ocrText).trim())
    .filter(Boolean)
    .join("\n\n");
}

export function prepareBlocksForStorage(blocks: DocumentBlock[]): DocumentBlock[] {
  return blocks.map((block) => {
    if (block.type === "text") return block;
    return {
      ...block,
      imageDataUrl: null,
      view: "text",
      ocrState: block.ocrText ? "done" : "idle",
      error: null
    };
  });
}

export function restoreBlocks(value: unknown, legacySource = ""): DocumentBlock[] {
  if (!Array.isArray(value)) return [createTextBlock(legacySource)];

  const blocks = value.flatMap<DocumentBlock>((candidate) => {
    if (!candidate || typeof candidate !== "object") return [];
    const block = candidate as Partial<DocumentBlock>;
    if (block.type === "text" && typeof block.text === "string") {
      return [{ id: block.id || createBlockId(), type: "text", text: block.text }];
    }
    if (block.type === "image" && typeof block.ocrText === "string") {
      return [{
        id: block.id || createBlockId(),
        type: "image",
        imageDataUrl: null,
        ocrText: block.ocrText,
        view: "text",
        ocrState: block.ocrText ? "done" : "idle",
        elapsedMs: typeof block.elapsedMs === "number" ? block.elapsedMs : null,
        error: null
      }];
    }
    return [];
  });

  return blocks.length > 0 ? blocks : [createTextBlock(legacySource)];
}
