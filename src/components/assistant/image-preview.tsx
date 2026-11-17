"use client";

import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";

/** Larger view of an image; `image` null = closed. */
export function ImagePreview({
  image,
  onClose,
}: {
  image: { src: string; name: string } | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={!!image} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-3xl">
        <DialogTitle className="truncate pr-8 text-xs font-medium">
          {image?.name}
        </DialogTitle>
        {image && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={image.src}
            alt={image.name}
            className="max-h-[75vh] w-full rounded-md object-contain"
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
