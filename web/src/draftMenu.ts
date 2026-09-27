type OptionGroup = {
  id: string;
  name: string;
  required: boolean;
  allowMultiple: boolean;
  options: Array<{ id: string; label: string }>;
};

export function sameOptionGroups(left: OptionGroup[], right: OptionGroup[]): boolean {
  const snapshot = (groups: OptionGroup[]) => JSON.stringify(groups.map((group) => ({
    id: group.id,
    name: group.name,
    required: group.required,
    allowMultiple: group.allowMultiple,
    options: group.options.map((option) => ({ id: option.id, label: option.label }))
      .sort((a, b) => a.id.localeCompare(b.id))
  })).sort((a, b) => a.id.localeCompare(b.id)));
  return snapshot(left) === snapshot(right);
}
