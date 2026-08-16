import {useEffect, useRef, useState} from 'react';
import {useStudio} from '../state/store';

/**
 * The files a suite uploads.
 *
 * Thumbnails because a gallery of file names is a directory listing, and the
 * whole point of picking an image is seeing which one it is.
 *
 * The edge cases are offered up front rather than left to be discovered. A valid
 * photo tests the case that already works; the uploads that break an API are the
 * empty file, the one whose extension lies, and the one that is twenty
 * megabytes — and nobody thinks to make those by hand.
 */
export function GalleryPanel() {
  const fixtures = useStudio((s) => s.fixtures);
  const refresh = useStudio((s) => s.refreshFixtures);
  const upload = useStudio((s) => s.uploadFixture);
  const remove = useStudio((s) => s.deleteFixture);
  const seed = useStudio((s) => s.seedFixtures);

  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  /** Fixtures the browser refused to decode — deliberate, for some of them. */
  const [broken, setBroken] = useState<Set<string>>(new Set());

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const take = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    setNote(null);
    for (const file of Array.from(files)) {
      const result = await upload(file);
      if (!result.ok) setNote(result.error ?? `could not add ${file.name}`);
    }
    setBusy(false);
  };

  // Bytes below a kilobyte, because "1 KB" for a 30-byte truncated file hides
  // the very thing that fixture exists to show.
  const size = (bytes: number) =>
    bytes >= 1024 * 1024
      ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
      : bytes >= 1024
        ? `${Math.round(bytes / 1024)} KB`
        : `${bytes} B`;

  return (
    <div className="rail-body">
      <div
        className={`drop ${dragging ? 'over' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          void take(e.dataTransfer.files);
        }}
        onClick={() => picker.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === 'Enter' && picker.current?.click()}
      >
        <strong>{busy ? 'Adding…' : 'Drop files here'}</strong>
        <span className="help">
          Images, PDFs and text. Kept in <code>fixtures/</code> and committed, so a journey that uploads
          a document still runs on somebody else's machine.
        </span>
      </div>
      <input
        ref={picker}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          void take(e.target.files);
          e.target.value = '';
        }}
      />

      {note && <div className="note bad">{note}</div>}

      {fixtures.length === 0 && (
        <>
          <p className="help">Nothing here yet.</p>
          <button
            className="btn go"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              const written = await seed();
              setNote(written.length ? `Added ${written.length} edge cases.` : 'They were already here.');
              setBusy(false);
            }}
          >
            Add the awkward ones
          </button>
          <span className="help">
            An empty file, one whose extension lies about its contents, a truncated image and a large
            valid one. The uploads that break things, which nobody makes by hand.
          </span>
        </>
      )}

      {fixtures.map((fixture) => (
        <div className="fixture" key={fixture.name}>
          {fixture.contentType.startsWith('image/') && fixture.bytes > 0 && !broken.has(fixture.name) ? (
            <img
              src={`/api/fixtures/${encodeURIComponent(fixture.name)}/raw`}
              alt={fixture.name}
              // A fixture that will not decode is the point of some of these, so
              // it falls back to a marker rather than leaving a broken image.
              onError={() => setBroken((b) => new Set(b).add(fixture.name))}
            />
          ) : (
            <span className={`glyph ${broken.has(fixture.name) ? 'bad' : ''}`}>
              {broken.has(fixture.name)
                ? 'NOT AN\nIMAGE'
                : fixture.bytes === 0
                  ? 'EMPTY'
                  : fixture.contentType.includes('pdf')
                    ? 'PDF'
                    : 'FILE'}
            </span>
          )}
          <div className="meta">
            <div className="nm">{fixture.name}</div>
            <div className="sub">
              {size(fixture.bytes)}
              {fixture.width ? ` · ${fixture.width}×${fixture.height}` : ''}
              {fixture.bytes === 0 ? ' · empty' : ''}
            </div>
            {fixture.note && <div className="why">{fixture.note}</div>}
          </div>
          <button
            className="btn danger"
            style={{fontSize: 11}}
            aria-label={`Delete ${fixture.name}`}
            onClick={() => void remove(fixture.name)}
          >
            ×
          </button>
        </div>
      ))}

      {fixtures.length > 0 && (
        <>
          <span className="caps">Using one</span>
          <p className="help">
            A step with a file field picks from here by name. The bytes are read by the proxy on the way
            out — they never go into the journey file, which is what keeps it reviewable.
          </p>
          <button className="btn" disabled={busy} onClick={() => void seed().then(() => setNote(null))}>
            Add the awkward ones
          </button>
        </>
      )}
    </div>
  );
}
