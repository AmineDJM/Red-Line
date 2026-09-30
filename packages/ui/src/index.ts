/**
 * Design system Red Line « Terminal tactique », commun au jeu, à la carte et au back-office.
 *
 * Styles : importer '@redline/ui/fonts.css', '@redline/ui/tokens.css' puis '@redline/ui/styles.css'.
 * Toutes les classes sont préfixées `rl-`. Aucun texte en dur hors libellés par défaut en français
 * surchargeables par props ; l'application fournit ses textes (i18n).
 *
 * Carte des composants :
 *  - Structure : Window (fenêtre de terminal flottante / plein écran), Prompt, Panel, SectionTitle,
 *    KeyValue, Stat, Drawer, Dialog.
 *  - Navigation : Tabs, Segmented, CommandPalette (console Ctrl+K).
 *  - Actions : Button, IconButton, Kbd.
 *  - Données : Table (tri), List/ListItem, ProgressBar, Gauge (jauge en blocs), Sparkline, Money,
 *    Countdown, Badge, StatusDot.
 *  - Formulaires : Field, Input, SearchInput, Select, Toggle, Slider, Checkbox.
 *  - Retour : Toast (ToastStack), Tooltip, EmptyState, Spinner.
 *  - Jeu : Flag, Pictogram, UnitMarker, WeaponCard, WeaponTile, WeaponPhoto, Legend, Icon.
 *  - Formats : formatMoney (`$1,2 Md`), formatInt, formatCompact, formatPct, formatCountdown.
 */
export * from './pictograms.js';
export * from './flags.js';
export * from './format.js';
export { Icon, ICONS, type IconName, type IconProps } from './icons.js';
export { HexIcon, type HexIconProps } from './components/HexIcon.js';
export {
  Pictogram,
  Flag,
  UnitMarker,
  type FlagProps,
  type UnitMarkerProps,
} from './components/Pictogram.js';
export {
  Button,
  IconButton,
  type ButtonProps,
  type ButtonVariant,
  type IconButtonProps,
} from './components/Button.js';
export { Kbd } from './components/Kbd.js';
export { Badge, StatusDot, type BadgeProps, type Tone } from './components/Badge.js';
export { Window, Prompt, type WindowProps, type WindowRect } from './components/Window.js';
export {
  Panel,
  SectionTitle,
  KeyValue,
  Stat,
  type PanelProps,
  type KeyValueProps,
  type StatProps,
} from './components/Panel.js';
export {
  Tabs,
  Segmented,
  type TabDef,
  type TabsProps,
  type SegmentedProps,
} from './components/Tabs.js';
export { Table, type Column, type TableProps } from './components/Table.js';
export { List, ListItem, type ListItemProps } from './components/List.js';
export {
  ProgressBar,
  Gauge,
  Sparkline,
  type ProgressBarProps,
  type GaugeProps,
} from './components/Progress.js';
export { Money, Countdown, type MoneyProps, type CountdownProps } from './components/Money.js';
export {
  Field,
  Input,
  SearchInput,
  Select,
  Toggle,
  Slider,
  Checkbox,
  type SearchInputProps,
  type SelectProps,
} from './components/Form.js';
export {
  EmptyState,
  Tooltip,
  ToastStack,
  Dialog,
  Spinner,
  type ToastItem,
} from './components/Feedback.js';
export { Drawer, type DrawerProps } from './components/Drawer.js';
export {
  WeaponCard,
  WeaponTile,
  WeaponPhoto,
  weaponSheetRows,
  type WeaponCardLabels,
  type WeaponCardProps,
  type WeaponTileProps,
  type WeaponPhotoInfo,
  type WeaponFact,
  type WeaponRow,
} from './components/WeaponCard.js';
export {
  CommandPalette,
  type CommandPaletteProps,
  type CommandSuggestion,
  type CommandLogLine,
} from './components/CommandPalette.js';
export { Legend, type LegendItem, type LegendProps } from './components/Legend.js';
