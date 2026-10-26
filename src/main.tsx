import { TooltipProvider } from "./components/ui/tooltip";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { installDesktopInteractions } from "./lib/desktop-interactions";

const cleanupDesktopInteractions = installDesktopInteractions(document);
if (import.meta.hot) import.meta.hot.dispose(cleanupDesktopInteractions);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <TooltipProvider delayDuration={350} skipDelayDuration={100}>
      <App />
    </TooltipProvider>
  </React.StrictMode>,
);
