import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function SvgIcon({
  size = 18,
  children,
  ...rest
}: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

/** Half-turn sweep / radar refresh */
export function IconRadarSweep(props: IconProps) {
  return (
    <SvgIcon {...props}>
      <path d="M12 2a10 10 0 1 0 10 10" />
      <path d="M12 6a6 6 0 1 0 6 6" />
      <path d="M12 12l6.5-6.5" />
      <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
    </SvgIcon>
  );
}

/** Manual bearing crosshair */
export function IconCrosshair(props: IconProps) {
  return (
    <SvgIcon {...props}>
      <circle cx="12" cy="12" r="7" />
      <line x1="12" y1="2" x2="12" y2="5" />
      <line x1="12" y1="19" x2="12" y2="22" />
      <line x1="2" y1="12" x2="5" y2="12" />
      <line x1="19" y1="12" x2="22" y2="12" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
    </SvgIcon>
  );
}

/** Undo last bearing */
export function IconUndo(props: IconProps) {
  return (
    <SvgIcon {...props}>
      <path d="M3 10h11a5 5 0 0 1 0 10H9" />
      <path d="M7 6L3 10l4 4" />
    </SvgIcon>
  );
}

/** Bidirectional line icon */
export function IconBidirectional(props: IconProps) {
  return (
    <SvgIcon {...props}>
      <path d="M5 12h14" />
      <path d="M9 8l-4 4 4 4" />
      <path d="M15 8l4 4-4 4" />
    </SvgIcon>
  );
}

/** Unidirectional ray icon */
export function IconUnidirectional(props: IconProps) {
  return (
    <SvgIcon {...props}>
      <circle cx="5" cy="12" r="2" fill="currentColor" stroke="none" />
      <path d="M7 12h12" />
      <path d="M14 7l5 5-5 5" />
    </SvgIcon>
  );
}

/** Punch / check mark */
export function IconCheck(props: IconProps) {
  return (
    <SvgIcon {...props}>
      <path d="M5 13l4.2 4.2L19 7.5" />
    </SvgIcon>
  );
}

/** Close X */
export function IconClose(props: IconProps) {
  return (
    <SvgIcon {...props}>
      <path d="M18 6L6 18" />
      <path d="M6 6l12 12" />
    </SvgIcon>
  );
}

/** Settings sliders / gear */
export function IconSettings(props: IconProps) {
  return (
    <SvgIcon {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.26.6.85 1 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </SvgIcon>
  );
}

/** Tools / layers menu */
export function IconSliders(props: IconProps) {
  return (
    <SvgIcon {...props}>
      <line x1="4" y1="6" x2="20" y2="6" />
      <line x1="4" y1="12" x2="20" y2="12" />
      <line x1="4" y1="18" x2="20" y2="18" />
      <circle cx="9" cy="6" r="2" fill="currentColor" stroke="none" />
      <circle cx="15" cy="12" r="2" fill="currentColor" stroke="none" />
      <circle cx="10" cy="18" r="2" fill="currentColor" stroke="none" />
    </SvgIcon>
  );
}

/** Route / trail path */
export function IconRoute(props: IconProps) {
  return (
    <SvgIcon {...props}>
      <circle cx="6" cy="19" r="2.5" />
      <circle cx="18" cy="5" r="2.5" />
      <path d="M9 19h5.5a3.5 3.5 0 0 0 0-7h-5a3.5 3.5 0 0 1 0-7H15" />
    </SvgIcon>
  );
}

/** Rays / signal lines */
export function IconRays(props: IconProps) {
  return (
    <SvgIcon {...props}>
      <path d="M4 20L20 4" />
      <path d="M4 11l16 6" />
      <circle cx="11.4" cy="12.6" r="2" fill="currentColor" stroke="none" />
    </SvgIcon>
  );
}

/** Recenter GPS */
export function IconLocate(props: IconProps) {
  return (
    <SvgIcon {...props}>
      <circle cx="12" cy="12" r="5" />
      <line x1="12" y1="2" x2="12" y2="5" />
      <line x1="12" y1="19" x2="12" y2="22" />
      <line x1="2" y1="12" x2="5" y2="12" />
      <line x1="19" y1="12" x2="22" y2="12" />
      <circle cx="12" cy="12" r="1.8" fill="currentColor" stroke="none" />
    </SvgIcon>
  );
}

/** Campus overview / fit bounds */
export function IconCampusFrame(props: IconProps) {
  return (
    <SvgIcon {...props}>
      <path d="M4 9V5a1 1 0 0 1 1-1h4" />
      <path d="M15 4h4a1 1 0 0 1 1 1v4" />
      <path d="M20 15v4a1 1 0 0 1-1 1h-4" />
      <path d="M9 20H5a1 1 0 0 1-1-1v-4" />
      <circle cx="12" cy="12" r="2" />
    </SvgIcon>
  );
}

/** Radio / virtual field practice */
export function IconRadio(props: IconProps) {
  return (
    <SvgIcon {...props}>
      <path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9" />
      <path d="M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5" />
      <circle cx="12" cy="12" r="2" fill="currentColor" stroke="none" />
      <path d="M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5" />
      <path d="M19.1 4.9C23 8.8 23 15.1 19.1 19" />
    </SvgIcon>
  );
}

/** Microphone / audio input */
export function IconMic(props: IconProps) {
  return (
    <SvgIcon {...props}>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <line x1="12" y1="18" x2="12" y2="21" />
    </SvgIcon>
  );
}

/** Speaker sound on */
export function IconVolume(props: IconProps) {
  return (
    <SvgIcon {...props}>
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <path d="M15.5 8.5a5 5 0 0 1 0 7" />
      <path d="M19 5a10 10 0 0 1 0 14" />
    </SvgIcon>
  );
}

/** Speaker muted */
export function IconVolumeOff(props: IconProps) {
  return (
    <SvgIcon {...props}>
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <line x1="22" y1="9" x2="16" y2="15" />
      <line x1="16" y1="9" x2="22" y2="15" />
    </SvgIcon>
  );
}

/** Compass */
export function IconCompass(props: IconProps) {
  return (
    <SvgIcon {...props}>
      <circle cx="12" cy="12" r="9" />
      <polygon points="15.5 8.5 13.5 13.5 8.5 15.5 10.5 10.5 15.5 8.5" />
    </SvgIcon>
  );
}

/** Screen wake lock sun */
export function IconSun(props: IconProps) {
  return (
    <SvgIcon {...props}>
      <circle cx="12" cy="12" r="4" />
      <line x1="12" y1="2" x2="12" y2="4.5" />
      <line x1="12" y1="19.5" x2="12" y2="22" />
      <line x1="4.9" y1="4.9" x2="6.7" y2="6.7" />
      <line x1="17.3" y1="17.3" x2="19.1" y2="19.1" />
      <line x1="2" y1="12" x2="4.5" y2="12" />
      <line x1="19.5" y1="12" x2="22" y2="12" />
      <line x1="4.9" y1="19.1" x2="6.7" y2="17.3" />
      <line x1="17.3" y1="6.7" x2="19.1" y2="4.9" />
    </SvgIcon>
  );
}

/** Map click simulation pin */
export function IconPinPlus(props: IconProps) {
  return (
    <SvgIcon {...props}>
      <path d="M12 21s-6-5.2-6-10a6 6 0 1 1 12 0c0 4.8-6 10-6 10z" />
      <line x1="12" y1="8" x2="12" y2="14" />
      <line x1="9" y1="11" x2="15" y2="11" />
    </SvgIcon>
  );
}

/** Eye reveal / hide truth */
export function IconEye(props: IconProps) {
  return (
    <SvgIcon {...props}>
      <path d="M2 12s3.8-6.5 10-6.5S22 12 22 12s-3.8 6.5-10 6.5S2 12 2 12z" />
      <circle cx="12" cy="12" r="2.8" />
    </SvgIcon>
  );
}

/** Refresh / regenerate */
export function IconRefresh(props: IconProps) {
  return (
    <SvgIcon {...props}>
      <path d="M21 12a9 9 0 0 1-15.4 6.4L3 16" />
      <path d="M3 12a9 9 0 0 1 15.4-6.4L21 8" />
      <polyline points="21 3 21 8 16 8" />
      <polyline points="3 21 3 16 8 16" />
    </SvgIcon>
  );
}

/** Alert octagon for non-target station warning */
export function IconAlertOctagon(props: IconProps) {
  return (
    <SvgIcon {...props}>
      <polygon points="7.86 2 16.14 2 22 7.86 22 16.14 16.14 22 7.86 22 2 16.14 2 7.86 7.86 2" />
      <line x1="12" y1="8" x2="12" y2="12.5" />
      <circle cx="12" cy="16.2" r="1" fill="currentColor" stroke="none" />
    </SvgIcon>
  );
}

/** Chevron up/down for sheet collapse */
export function IconChevron(props: IconProps & { up?: boolean }) {
  const { up, ...rest } = props;
  return (
    <SvgIcon {...rest}>
      {up ? <polyline points="6 15 12 9 18 15" /> : <polyline points="6 9 12 15 18 9" />}
    </SvgIcon>
  );
}

/** Play triangle */
export function IconPlay(props: IconProps) {
  return (
    <SvgIcon {...props}>
      <polygon points="6 4 20 12 6 20 6 4" fill="currentColor" stroke="none" />
    </SvgIcon>
  );
}

/** Stop square */
export function IconStop(props: IconProps) {
  return (
    <SvgIcon {...props}>
      <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" />
    </SvgIcon>
  );
}
