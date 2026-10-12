/** Keep the internal code visible as a stable disambiguator for repeated labels. */
export function resourceLabel(resource: {
  code: string;
  display_label?: string | null;
  location_path?: readonly string[];
  parent_display_label?: string | null;
  parent_code?: string | null;
}): string {
  const label = resource.display_label || resource.code;
  const parent = resource.parent_display_label || resource.parent_code;
  return [
    ...(resource.location_path ?? []),
    ...(parent ? [parent] : []),
    resource.display_label && label !== resource.code
      ? `${label} (${resource.code})`
      : label,
  ].join(' / ');
}
