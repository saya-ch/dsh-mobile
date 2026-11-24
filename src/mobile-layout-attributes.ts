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
