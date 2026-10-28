# FK link interaction

FK cells expose one reference tooltip. Only the rendered link text navigates; blank cell space selects the cell. Truncated labels stay within the column, and Enter/Space activate the focused link without triggering the cell inspector. Ordinary cells retain their existing inspection tooltip.

Scope: DataGrid tooltip/button handling and FK button sizing. Verify with rendered browser interactions plus the existing test/build gates.
