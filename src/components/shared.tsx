import {
  AlertCircle,
  Database,
  LoaderCircle,
  RefreshCw,
  Unplug,
  Plug,
} from "lucide-react";
import { Button } from "./ui/button";
import { copy } from "../lib/api";
import { notify } from "../lib/store";
import type { ReactNode } from "react";
export function Empty({
  icon,
  title,
  detail,
  children,
}: {
  icon?: ReactNode;
  title: string;
  detail?: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon">
        {icon || <Database size={25} strokeWidth={1.4} />}
      </div>
      <h2>{title}</h2>
      {detail && <p>{detail}</p>}
      {children}
    </div>
  );
}
export function DisconnectedState({
  connection,
  table,
  onReconnect,
}: {
  connection?: string;
  table?: string;
  onReconnect: () => void;
}) {
  return (
    <div className="connection-state">
      <div>
        <span className="connection-state-icon">
          <Unplug size={24} strokeWidth={1.5} />
        </span>
        <h2>Database disconnected</h2>
        <p>
          {connection
            ? `${connection} is offline.`
            : "This workspace has no active connection."}{" "}
          Reconnect to {table ? `view ${table}` : "continue exploring"}.
        </p>
        <Button variant="secondary" onClick={onReconnect}>
          <Plug size={14} />
          {connection ? "Reconnect…" : "Choose connection…"}
        </Button>
      </div>
    </div>
  );
}
export function ErrorState({
  error,
  retry,
}: {
  error: string;
  retry?: () => void;
}) {
  return (
    <div className="error-state" role="alert">
      <AlertCircle size={17} />
      <span>{error}</span>
      {retry && (
        <Button variant="ghost" size="sm" onClick={retry}>
          <RefreshCw size={13} />
          Retry
        </Button>
      )}
    </div>
  );
}
export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="loading" role="status">
      <LoaderCircle size={16} className="spin" />
      {label}
    </div>
  );
}
export async function copyFeedback(text: string) {
  try {
    await copy(text);
    notify("Copied to clipboard");
  } catch {
    notify("Clipboard access failed.", true);
  }
}
export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
export function Tag({
  children,
  tone = "",
}: {
  children: ReactNode;
  tone?: string;
}) {
  return <span className={`tag ${tone}`}>{children}</span>;
}

export function WorkflowHelp({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <details className="workflow-help">
      <summary>How to {title}</summary>
      <div>{children}</div>
    </details>
  );
}
