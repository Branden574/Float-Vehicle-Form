import { useState, useId } from 'react';
import diagram from '../../shared/vehicle-diagram.json';
import type { Damage } from '../types';

export function DamageDiagram({
  damage,
  baseline,
  onChange,
  label = 'Vehicle damage diagram',
}: {
  damage: Damage[];
  baseline?: Damage[];
  onChange?: (damage: Damage[]) => void;
  label?: string;
}) {
  const helpId = useId();
  const [type, setType] = useState<Damage['type']>('dent');
  const [selected, setSelected] = useState<number | null>(null),
    [moving, setMoving] = useState(false);
  const [cursor, setCursor] = useState({ x: 0.5, y: 0.5 });
  const place = (x: number, y: number) => {
    const position = {
      x: Math.min(0.98, Math.max(0.02, x)),
      y: Math.min(0.98, Math.max(0.02, y)),
      diagram: 'vehicle-v1' as const,
    };
    if (!onChange) return;
    if (moving && selected !== null && damage[selected]) {
      onChange(damage.map((d, i) => (i === selected ? { ...d, position } : d)));
      setMoving(false);
      return;
    }
    if (damage.length >= 40) return;
    const area =
      y < 0.17
        ? 'front'
        : y > 0.84
          ? 'rear'
          : x < 0.3
            ? 'driver'
            : x > 0.7
              ? 'passenger'
              : y < 0.42
                ? 'windshield'
                : 'roof';
    onChange([...damage, { area, type, notes: '', position }]);
    setSelected(damage.length);
  };
  return (
    <section className="damage-diagram">
      {baseline && (
        <p className="damage-baseline-key">
          Amber C marks: checkout damage (read-only). Blue N marks: new damage at return.
        </p>
      )}
      {onChange && (
        <>
          <div className="damage-tools" role="group" aria-label="Damage mark type">
            {(['chip', 'dent', 'scratch'] as const).map((t) => (
              <button
                type="button"
                key={t}
                aria-pressed={type === t}
                onClick={() => {
                  setType(t);
                  setMoving(false);
                }}
              >
                <span aria-hidden="true">{t === 'dent' ? '×' : t === 'scratch' ? '~' : '⁙'}</span>{' '}
                {t[0].toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>
          <p id={helpId}>
            {moving
              ? 'Tap the new position for the selected mark.'
              : 'Choose a type, then tap the diagram. Tap a mark to select it.'}{' '}
            Front is at the top; driver side is on the left.
          </p>
        </>
      )}
      <svg
        viewBox="0 0 360 560"
        className="vehicle-damage-canvas"
        role={onChange ? 'application' : 'img'}
        aria-label={label}
        aria-describedby={onChange ? helpId : undefined}
        tabIndex={onChange ? 0 : undefined}
        onKeyDown={(e) => {
          if (!onChange) return;
          const step = 0.025;
          if (e.key.startsWith('Arrow')) {
            e.preventDefault();
            setCursor((c) => ({
              x: Math.max(
                0.02,
                Math.min(
                  0.98,
                  c.x + (e.key === 'ArrowRight' ? step : e.key === 'ArrowLeft' ? -step : 0),
                ),
              ),
              y: Math.max(
                0.02,
                Math.min(
                  0.98,
                  c.y + (e.key === 'ArrowDown' ? step : e.key === 'ArrowUp' ? -step : 0),
                ),
              ),
            }));
          }
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            place(cursor.x, cursor.y);
          }
        }}
        onClick={(e) => {
          const matrix = e.currentTarget.getScreenCTM();
          if (!matrix) return;
          const point = new DOMPoint(e.clientX, e.clientY).matrixTransform(matrix.inverse());
          place(point.x / diagram.width, point.y / diagram.height);
        }}
      >
        <rect width="360" height="560" fill="#fff" />
        <g fill="none" stroke="#65716c" strokeWidth="1.5">
          {diagram.paths.map((d, i) => (
            <path key={i} d={d} />
          ))}
          {diagram.circles.map(([cx, cy, r], i) => (
            <circle key={i} cx={cx} cy={cy} r={r} />
          ))}
        </g>
        {onChange && (
          <circle
            className="keyboard-mark-cursor"
            cx={cursor.x * 360}
            cy={cursor.y * 560}
            r="10"
            fill="none"
            stroke="#126b61"
            strokeDasharray="3 3"
          />
        )}
        {baseline?.map(
          (d, i) =>
            d.position && (
              <g
                key={`checkout-${i}`}
                style={{ pointerEvents: 'none' }}
                aria-label={`Checkout mark C${i + 1}: ${d.type}`}
              >
                <circle
                  cx={d.position.x * 360}
                  cy={d.position.y * 560}
                  r="14"
                  fill="none"
                  stroke="#975712"
                  strokeDasharray="3 3"
                />
                <path
                  d={diagram.marks[d.type]}
                  transform={`translate(${d.position.x * 360} ${d.position.y * 560})`}
                  fill="none"
                  stroke="#975712"
                  strokeWidth="2"
                />
                <text
                  x={d.position.x * 360 + 11}
                  y={d.position.y * 560 - 9}
                  fill="#975712"
                  fontSize="13"
                  fontWeight="700"
                >
                  C{i + 1}
                </text>
              </g>
            ),
        )}
        {damage.map(
          (d, i) =>
            d.position && (
              <g
                key={i}
                className="damage-pin"
                style={{ pointerEvents: moving || !onChange ? 'none' : undefined }}
                onClick={(e) => {
                  e.stopPropagation();
                  setSelected(i);
                  setMoving(false);
                }}
                aria-label={`Mark ${i + 1}: ${d.type}`}
              >
                {selected === i && onChange && (
                  <circle
                    cx={d.position.x * 360}
                    cy={d.position.y * 560}
                    r="20"
                    fill="#126b611a"
                    stroke="#126b61"
                  />
                )}
                <circle cx={d.position.x * 360} cy={d.position.y * 560} r="20" fill="transparent" />
                <path
                  d={diagram.marks[d.type]}
                  transform={`translate(${d.position.x * 360} ${d.position.y * 560})`}
                  fill="none"
                  stroke="#143d81"
                  strokeWidth="2"
                />
                <text
                  x={d.position.x * 360 + 11}
                  y={d.position.y * 560 - 9}
                  fill="#143d81"
                  fontSize="13"
                  fontWeight="700"
                >
                  {baseline ? 'N' : ''}
                  {i + 1}
                </text>
              </g>
            ),
        )}
      </svg>
      {onChange && (
        <>
          <div className="damage-edit-tools">
            <label>
              Selected mark
              <select
                aria-label="Selected damage mark"
                value={selected !== null && damage[selected] ? selected : ''}
                onChange={(e) => {
                  setSelected(e.target.value === '' ? null : Number(e.target.value));
                  setMoving(false);
                }}
              >
                <option value="">Choose a mark</option>
                {damage.map((d, i) => (
                  <option key={i} value={i}>
                    {i + 1}. {d.type} — {d.area}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="button secondary compact"
              disabled={selected === null || !damage[selected]}
              onClick={() => setMoving(true)}
            >
              Move mark
            </button>
            <button
              type="button"
              className="button secondary compact"
              disabled={selected === null || !damage[selected]}
              onClick={() => {
                onChange(damage.filter((_, i) => i !== selected));
                setSelected(null);
                setMoving(false);
              }}
            >
              Remove mark
            </button>
            <button
              type="button"
              className="button secondary compact"
              disabled={!damage.length}
              onClick={() => {
                onChange(damage.slice(0, -1));
                setSelected(null);
                setMoving(false);
              }}
            >
              Undo last mark
            </button>
          </div>
          <p className="muted" aria-live="polite">
            {damage.length} of 40 marks. Add notes below. Keyboard: arrow keys position the cursor;
            Enter places a mark.
          </p>
        </>
      )}
      {!onChange && damage.length === 0 && <p>No damage recorded.</p>}
      {baseline?.some((d) => !d.position) && (
        <p>Checkout also includes area-only damage with no exact position:</p>
      )}
      {baseline?.map(
        (d, i) =>
          !d.position && (
            <p key={`legacy-${i}`}>
              C{i + 1}: {d.area} — {d.type}. {d.notes}
            </p>
          ),
      )}
      {damage.some((d) => !d.position) && (
        <p>Area-only entries are listed below; no exact location was recorded.</p>
      )}
    </section>
  );
}
