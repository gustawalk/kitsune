import { Tooltip as Primitive } from "radix-ui";
import {
  createContext,
  useContext,
  type ReactElement,
  type ReactNode,
} from "react";
const Provided = createContext(false);
export function TooltipProvider({
  children,
  ...props
}: React.ComponentProps<typeof Primitive.Provider>) {
  return (
    <Provided.Provider value={true}>
      <Primitive.Provider {...props}>{children}</Primitive.Provider>
    </Provided.Provider>
  );
}
export function Tooltip({
  content,
  children,
  disabledTrigger = false,
}: {
  content?: ReactNode;
  children: ReactElement;
  disabledTrigger?: boolean;
}) {
  const provided = useContext(Provided);
  if (!content) return children;
  if (!provided)
    return (
      <TooltipProvider delayDuration={350}>
        <Tooltip content={content} disabledTrigger={disabledTrigger}>
          {children}
        </Tooltip>
      </TooltipProvider>
    );
  return (
    <Primitive.Root>
      <Primitive.Trigger asChild>
        {disabledTrigger ? (
          <span className="tooltip-disabled" tabIndex={0}>
            {children}
          </span>
        ) : (
          children
        )}
      </Primitive.Trigger>
      <Primitive.Portal>
        <Primitive.Content
          className="tooltip-content"
          sideOffset={7}
          collisionPadding={10}
        >
          {content}
          <Primitive.Arrow className="tooltip-arrow" />
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}
