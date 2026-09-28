import type { TextFilePart } from "./conversation-store";
import {
  MAX_ATTACHED_TEXT_FILES,
  MAX_TEXT_FILE_BYTES,
  MAX_TEXT_FILE_NAME_CHARS,
  MAX_TOTAL_TEXT_ATTACHMENT_BYTES,
  formatTextAttachmentPrompt,
  isValidTextAttachmentData,
  textAttachmentBytes,
  textAttachmentPromptBytes,
} from "./text-attachment-policy";

export {
  MAX_ATTACHED_TEXT_FILES,
  MAX_TEXT_FILE_BYTES,
  MAX_TOTAL_TEXT_ATTACHMENT_BYTES,
} from "./text-attachment-policy";

const TEXT_EXTENSIONS = new Set([
  "c", "cc", "cpp", "cs", "css", "csv", "go", "h", "hpp", "html", "ini", "java",
  "js", "json", "jsx", "log", "md", "ps1", "py", "rs", "sh", "sql", "toml", "ts",
  "tsx", "tsv", "txt", "xml", "yaml", "yml",
]);
const TEXT_NAMES = new Set(["dockerfile", "makefile"]);

function safeFileName(name: string): string {
  return name
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, MAX_TEXT_FILE_NAME_CHARS) || "attachment.txt";
}

export function isSupportedTextAttachment(file: Pick<File, "name" | "type">): boolean {
  if (file.type.startsWith("text/")) return true;
  const lowerName = file.name.toLowerCase();
  if (TEXT_NAMES.has(lowerName)) return true;
  const dot = lowerName.lastIndexOf(".");
  return dot >= 0 && TEXT_EXTENSIONS.has(lowerName.slice(dot + 1));
}

export async function prepareTextAttachment(file: File): Promise<TextFilePart> {
  if (!isSupportedTextAttachment(file)) {
    throw new Error(`${file.name || "The selected file"} is not a supported text or code file.`);
  }
  if (file.size > MAX_TEXT_FILE_BYTES) {
    throw new Error(`${file.name || "The selected file"} is larger than 128 KB.`);
  }
  const text = await file.text();
  if (text.includes("\0")) {
    throw new Error(`${file.name || "The selected file"} appears to contain binary data.`);
  }
  const part: TextFilePart = {
    type: "file_text",
    file: {
      name: safeFileName(file.name),
      text,
      ...(file.type ? { mimeType: file.type } : {}),
    },
  };
  if (!isValidTextAttachmentData(part.file)) {
    throw new Error(`${file.name || "The selected file"} is larger than 128 KB after decoding.`);
  }
  return part;
}

export interface PreparedTextAttachmentBatch {
  prepared: TextFilePart[];
  errors: string[];
  rejectedCount: number;
  overflow: number;
}

export interface PrepareTextAttachmentBatchOptions {
  prepare?: (file: File) => Promise<TextFilePart>;
  canAccept?: (prepared: readonly TextFilePart[], candidate: TextFilePart) => boolean;
}

/**
 * Continue past failed files until the available slots are filled by successful preparations
 * or every selected file has been attempted. `overflow` counts only files never attempted.
 */
export async function prepareTextAttachmentBatch(
  files: readonly File[],
  availableSlots: number,
  { prepare = prepareTextAttachment, canAccept = () => true }: PrepareTextAttachmentBatchOptions = {},
): Promise<PreparedTextAttachmentBatch> {
  const prepared: TextFilePart[] = [];
  const errors: string[] = [];
  let rejectedCount = 0;
  const limit = Math.max(0, Math.floor(availableSlots));
  let attempted = 0;

  while (attempted < files.length && prepared.length < limit) {
    const file = files[attempted++];
    try {
      const candidate = await prepare(file);
      if (canAccept(prepared, candidate)) prepared.push(candidate);
      else rejectedCount += 1;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  return { prepared, errors, rejectedCount, overflow: files.length - attempted };
}

export function mergePreparedTextAttachments(
  current: TextFilePart[],
  prepared: TextFilePart[],
): { attachments: TextFilePart[]; added: TextFilePart[]; rejectedCount: number } {
  const attachments = [...current];
  const added: TextFilePart[] = [];
  let totalBytes = attachments.reduce(
    (total, part) => total + textAttachmentPromptBytes(part.file),
    0,
  );
  let rejectedCount = 0;

  for (const part of prepared) {
    const bytes = textAttachmentPromptBytes(part.file);
    if (
      !isValidTextAttachmentData(part.file)
      || attachments.length >= MAX_ATTACHED_TEXT_FILES
      || totalBytes + bytes > MAX_TOTAL_TEXT_ATTACHMENT_BYTES
    ) {
      rejectedCount += 1;
      continue;
    }
    attachments.push(part);
    added.push(part);
    totalBytes += bytes;
  }

  return { attachments, added, rejectedCount };
}

export function promptTextForFile(part: TextFilePart): string {
  return formatTextAttachmentPrompt(part.file);
}
