import { useState } from 'preact/hooks';

export type TicketFileChip = { name: string; kind?: 'image' | 'text' | undefined; /** Where the picture can be shown from, while it can. */ src?: string | undefined; note?: string | undefined };

const Icon = ({ kind }: { kind: TicketFileChip['kind'] }) => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  {kind === 'image' ? <><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="10" r="1.6" /><path d="m4 18 5-5 4 4 3-3 4 4" /></>
    : <><path d="M7 3h7l5 5v13H7z" /><path d="M14 3v5h5" />{kind === 'text' && <path d="M10 13h6M10 17h6" />}</>}
</svg>;

/** One file of a ticket: a picture as a thumbnail that opens full size, anything else as an icon with its name. A picture that cannot be loaded falls back to the icon. */
function Chip({ file }: { file: TicketFileChip }) {
  const [broken, setBroken] = useState(false); const word = file.kind === 'image' ? 'Picture' : file.kind === 'text' ? 'Text file' : 'File';
  const label = <span class="tf-name wrap-anywhere">{file.name}{file.note && <span class="tf-note">{file.note}</span>}</span>;
  if (file.kind === 'image' && file.src && !broken) return <li class="tf-file"><a class="tf-thumb" href={file.src} target="_blank" rel="noopener noreferrer" title={`Open ${file.name} full size`} aria-label={`Open ${file.name} full size`}><img src={file.src} alt={`${file.name}, picture from the ticket`} loading="lazy" onError={() => setBroken(true)} /></a>{label}</li>;
  return <li class="tf-file"><span class="tf-icon" role="img" aria-label={word}><Icon kind={file.kind} /></span>{label}</li>;
}
export function TicketFileList({ files, label }: { files: TicketFileChip[]; label: string }) {
  return <ul class="tf-strip" aria-label={label}>{files.map((file, index) => <Chip key={`${index}:${file.name}`} file={file} />)}</ul>;
}
