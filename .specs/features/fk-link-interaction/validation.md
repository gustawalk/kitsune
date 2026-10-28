# FK link interaction validation

## Validation: FK link interaction - PASS

`src/components/DataGrid.tsx:567` suppresses the generic inspection tooltip for FK cells. The FK button retains its existing single native title with label/ID/reference information.

`src/App.css:1040` sizes the button to its text with no padding and a maximum of the cell content width. Blank cell space follows the cell selection handler rather than the navigation callback. `src/components/DataGrid.tsx:608` preserves native Enter/Space activation by preventing the grid inspector/selection shortcuts from intercepting button keys.

Rendered browser fixture `/tmp/playwright-test-fk-hit-target.js`: verifies FK hover exposes no additional Radix tooltip, the native title remains, short-link bounds are narrower than the cell, blank/padding clicks select without navigation, text clicks and Enter navigate, long labels stay clipped within their column, and ordinary cells retain their inspection tooltip.

`bun test`: 73 pass, 0 fail. `bun run build`: passed (contract consistency, TypeScript, Vite). Scoped Prettier and git diff checks pass. No existing regression tests changed.
