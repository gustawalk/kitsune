import { Clock3, Network, Trash2 } from "lucide-react";
import { Button } from "../components/ui/button";
import { Empty, ErrorState, Loading } from "../components/shared";
import { api, invalidate, useRemote } from "../lib/api";
import { notify, openTab } from "../lib/store";
import type { Bootstrap } from "../lib/types";

export function InvestigationsWorkspace() {
  const saved = useRemote<Bootstrap>("bootstrap", {});
  const investigations = saved.data?.investigations || [];
  return (
    <section className="workspace-page">
      <header className="workspace-heading">
        <div>
          <div className="eyebrow">Investigation mode</div>
          <h1>
            <Network size={20} /> Investigations
          </h1>
        </div>
      </header>
      {saved.error && (
        <ErrorState error={saved.error} retry={() => void saved.refresh()} />
      )}
      {saved.loading && !saved.data ? (
        <Loading label="Loading investigations…" />
      ) : investigations.length === 0 ? (
        <Empty
          title="No saved investigations"
          detail="Start from a record and save an investigation to return to it here."
        />
      ) : (
        <div className="investigation-list">
          {investigations.map((item) => (
            <article className="investigation-list-item" key={item.id}>
              <button
                className="investigation-open"
                onClick={() =>
                  openTab({
                    kind: "investigation",
                    title: item.name,
                    connectionId: item.root.connectionId,
                    root: item.root,
                    investigation: item,
                  })
                }
              >
                <Network size={16} />
                <span>
                  <strong>{item.name}</strong>
                  <small>
                    {item.root.table.schema ? `${item.root.table.schema}.` : ""}
                    {item.root.table.name} · {Object.keys(item.root.key).length}{" "}
                    key field(s)
                  </small>
                </span>
                <Clock3 size={14} />
              </button>
              <Button
                size="icon"
                variant="ghost"
                title={`Delete ${item.name}`}
                onClick={() =>
                  void api("delete_investigation", { id: item.id })
                    .then(() => {
                      invalidate("bootstrap:");
                      notify("Investigation deleted");
                    })
                    .catch((e) => notify(String(e), true))
                }
              >
                <Trash2 size={14} />
              </Button>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
