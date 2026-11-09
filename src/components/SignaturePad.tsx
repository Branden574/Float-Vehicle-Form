import { useEffect, useRef } from 'react';
import { RotateCcw } from 'lucide-react';
export function SignaturePad({
  value,
  onChange,
  label = 'Your signature',
}: {
  value: string;
  onChange: (signature: string) => void;
  label?: string;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const touched = useRef(false);
  useEffect(() => {
    if (!canvas.current) return;
    const context = canvas.current.getContext('2d')!;
    context.clearRect(0, 0, 1000, 320);
    if (value) {
      const image = new Image();
      image.onload = () => context.drawImage(image, 0, 0, 1000, 320);
      image.src = value;
    }
  }, []);
  function point(event: React.PointerEvent<HTMLCanvasElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    return [
      ((event.clientX - bounds.left) * 1000) / bounds.width,
      ((event.clientY - bounds.top) * 320) / bounds.height,
    ];
  }
  function finish() {
    if (!drawing.current) return;
    drawing.current = false;
    if (touched.current) onChange(canvas.current!.toDataURL('image/png'));
  }
  return (
    <div className="signature-field">
      <div className="row between">
        <label>{label}</label>
        <button
          type="button"
          className="text-button"
          onClick={() => {
            canvas.current?.getContext('2d')?.clearRect(0, 0, 1000, 320);
            touched.current = false;
            onChange('');
          }}
        >
          <RotateCcw size={15} /> Clear
        </button>
      </div>
      <div className="signature-box">
        <canvas
          ref={canvas}
          width="1000"
          height="320"
          aria-label={label}
          onPointerDown={(event) => {
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            drawing.current = true;
            touched.current = false;
            const context = event.currentTarget.getContext('2d')!;
            context.strokeStyle = '#263c34';
            context.lineWidth = 4;
            context.lineCap = 'round';
            context.lineJoin = 'round';
            context.beginPath();
            const [x, y] = point(event);
            context.moveTo(x, y);
          }}
          onPointerMove={(event) => {
            if (!drawing.current) return;
            touched.current = true;
            const [x, y] = point(event);
            const context = event.currentTarget.getContext('2d')!;
            context.lineTo(x, y);
            context.stroke();
          }}
          onPointerUp={finish}
          onPointerCancel={finish}
        />
        <span className="signature-baseline">Sign with your finger or pointer</span>
      </div>
      <p className="fine">This signature is applied only to your own acknowledgment.</p>
    </div>
  );
}
