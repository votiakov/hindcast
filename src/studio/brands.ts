/** Footer branding baked into every exported frame. Edit freely. */
export interface Brand {
  id: string;
  name: string;
  /** one line under the name */
  line: string;
  /** shown on the right of the footer, e.g. a URL or handle */
  link: string;
  initials: string;
  accent: string;
}

export const BRANDS: Brand[] = [
  {
    id: 'personal',
    name: 'Andrii Votiakov',
    line: 'System design, made visible',
    link: 'Follow for more ↗',
    initials: 'AV',
    accent: '#22d3ee',
  },
  {
    id: 'reducecost',
    name: 'reducecost.cloud',
    line: 'Cloud cost reduction',
    link: 'reducecost.cloud',
    initials: 'RC',
    accent: '#34d399',
  },
];

export const brandById = (id: string) => BRANDS.find((b) => b.id === id) ?? BRANDS[0];
