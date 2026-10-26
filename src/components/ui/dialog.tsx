import { Dialog as Primitive } from "radix-ui";
import { X } from "lucide-react";
import type { ReactNode } from "react";
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  wide = false,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <Primitive.Root
      open={open}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
    >
      <Primitive.Portal>
        <Primitive.Overlay className="dialog-overlay" />
        <Primitive.Content className={`dialog ${wide ? "dialog-wide" : ""}`}>
          <header>
            <div>
              <Primitive.Title>{title}</Primitive.Title>
              {description && (
                <Primitive.Description>{description}</Primitive.Description>
              )}
            </div>
            <Primitive.Close className="icon-button" aria-label="Close dialog">
              <X size={17} />
            </Primitive.Close>
          </header>
          {children}
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}
