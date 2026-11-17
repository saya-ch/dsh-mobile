/**
 * Root marker the dedicated layout publishes for its wide/narrow band.
 *
 * The band depends on the device screen size, which a media query cannot read,
 * so the layout decides it in JS and writes this attribute on `.dshm-shell`:
 * `"1"` docks the sidebar, anything else — `"0"`, or no marker — is the overlay
 * drawer. The stylesheet and the sidebar scroll adapter both follow the marker,
 * so the band has exactly one owner.
 *
 * This module stays free of imports: the dedicated layout bundle and the native
 * client bundle both use it, and neither should pull the other in.
 */
export const WIDE_LAYOUT_ATTRIBUTE = 'data-dshm-wide'

/**
 * Root marker for a centred conversation column inside the wide band.
 *
 * The wide band alone does not decide the column: the shell only centres it when
 * the main area left after the docked drawer and a docked right track still keeps
 * a readable width, which is another JS measurement. `"1"` narrows the column
 * with the `--dshm-content-column-gutter` the shell publishes, because the slot
 * anchor is `display: contents` and cannot carry a width itself; anything else —
 * `"0"`, or no marker — keeps the full-width column. A third-party panel
 * (`data-dsh-panel="1"`) is never centred, because that surface owns its layout.
 */
export const CENTERED_CONTENT_COLUMN_ATTRIBUTE = 'data-dshm-content-column'
