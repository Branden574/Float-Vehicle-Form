import { useEffect, useRef, useState } from 'react';
import { Camera, Check, ImagePlus, RotateCcw, Upload, X } from 'lucide-react';
import { errorMessage, formatDate, uploadPhoto } from '../api';
import type { Photo, Settings } from '../types';
export const requiredViews = ['front', 'rear', 'driver', 'passenger'] as const;
export const viewLabels: Record<string, string> = {
  front: 'Front',
  rear: 'Rear',
  driver: 'Driver side',
  passenger: 'Passenger side',
  windshield: 'Windshield',
  interior: 'Interior',
  odometer: 'Odometer',
  receipt: 'Fuel receipt',
  wheels: 'Wheels',
  damage: 'Damage',
  other: 'Additional view',
};
type Slot = {
  key: string;
  view: string;
  photo?: Photo;
  file?: File;
  preview?: string;
  source?: 'camera' | 'upload';
  capturedAt?: string;
  progress: number;
  busy: boolean;
  error?: string;
};
export function PhotoCapture({
  vehicleId,
  tripId,
  stage,
  draftId,
  settings,
  onChange,
}: {
  vehicleId: string;
  tripId?: string;
  stage: 'checkout' | 'return';
  draftId: string;
  settings: Settings;
  onChange: (photos: Photo[]) => void;
}) {
  const required = [...new Set([...requiredViews, ...(settings.requiredPhotoViews || [])])];
  const [slots, setSlots] = useState<Slot[]>(
    required.map((view) => ({ key: view, view, progress: 0, busy: false })),
  );
  const [cameraKey, setCameraKey] = useState<string | null>(null);
  const [cameraError, setCameraError] = useState('');
  const [cameraReady, setCameraReady] = useState(false);
  const [additionalView, setAdditionalView] = useState('damage');
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const urls = useRef(new Set<string>());
  useEffect(() => {
    onChange(
      slots.flatMap((slot) => (slot.photo && !slot.busy && !slot.error ? [slot.photo] : [])),
    );
  }, [slots]);
  useEffect(
    () => () => {
      stream.current?.getTracks().forEach((track) => track.stop());
      urls.current.forEach((url) => URL.revokeObjectURL(url));
    },
    [],
  );
  useEffect(() => {
    if (!cameraKey) return;
    let stopped = false;
    setCameraError('');
    setCameraReady(false);
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraError(
        'Camera access needs HTTPS and a supported browser. Open this app in Safari over its secure address.',
      );
      return;
    }
    navigator.mediaDevices
      .getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1920 },
          height: { ideal: 1440 },
        },
        audio: false,
      })
      .then((media) => {
        if (stopped) {
          media.getTracks().forEach((track) => track.stop());
          return;
        }
        stream.current = media;
        if (video.current) {
          video.current.srcObject = media;
          video.current.play().catch(() => setCameraError('Tap the video to enable the camera.'));
        }
      })
      .catch(() =>
        setCameraError(
          'Camera access was not granted. Allow Camera for this website in Safari settings, then try again. If permitted by your administrator, you can upload a new photograph instead.',
        ),
      );
    return () => {
      stopped = true;
      stream.current?.getTracks().forEach((track) => track.stop());
      stream.current = null;
    };
  }, [cameraKey]);
  function update(key: string, values: Partial<Slot>) {
    setSlots((current) =>
      current.map((slot) => (slot.key === key ? { ...slot, ...values } : slot)),
    );
  }
  async function send(key: string, file: File, source: 'camera' | 'upload', capturedAt: string) {
    const slot = slots.find((item) => item.key === key);
    if (!slot) return;
    const preview = URL.createObjectURL(file);
    urls.current.add(preview);
    update(key, {
      file,
      preview,
      source,
      capturedAt,
      busy: true,
      progress: 0,
      error: undefined,
      photo: undefined,
    });
    const data = new FormData();
    data.append('file', file);
    Object.entries({
      vehicleId,
      stage,
      view: slot.view,
      draftId,
      deviceCapturedAt: capturedAt,
      source,
      ...(tripId ? { tripId } : {}),
    }).forEach(([name, value]) => data.append(name, value));
    try {
      const photo = await uploadPhoto(data, (value) => update(key, { progress: value }));
      update(key, { photo, busy: false, progress: 100 });
    } catch (error) {
      update(key, { busy: false, error: errorMessage(error) });
    }
  }
  async function capture() {
    if (!video.current || !cameraKey || !cameraReady) return;
    const key = cameraKey;
    const shot = document.createElement('canvas');
    shot.width = video.current.videoWidth;
    shot.height = video.current.videoHeight;
    shot.getContext('2d')!.drawImage(video.current, 0, 0);
    const time = new Date().toISOString();
    shot.toBlob(
      (blob) => {
        if (blob) {
          setCameraKey(null);
          void send(
            key,
            new File([blob], `camera-${Date.now()}.jpg`, { type: 'image/jpeg' }),
            'camera',
            time,
          );
        }
      },
      'image/jpeg',
      0.94,
    );
  }
  const complete = slots.filter(
    (slot) => required.includes(slot.view) && slot.photo && !slot.busy && !slot.error,
  ).length;
  return (
    <div className="photo-capture">
      <div className="section-heading">
        <div>
          <h3>{stage === 'return' ? 'Take new return photographs' : 'Photograph the vehicle'}</h3>
          <p>Stand back to include the entire side. Take each view separately.</p>
        </div>
        <span className={`progress-count ${complete === required.length ? 'complete' : ''}`}>
          <Camera size={17} />
          {complete} / {required.length} required
        </span>
      </div>
      <div className="photo-grid">
        {slots.map((slot) => (
          <article className={`photo-slot ${slot.photo ? 'uploaded' : ''}`} key={slot.key}>
            <div className="photo-label">
              <strong>{viewLabels[slot.view]}</strong>
              {slot.photo ? (
                <span>
                  <Check size={14} /> Stored
                </span>
              ) : (
                <span>{required.includes(slot.view) ? 'Required' : 'Optional'}</span>
              )}
            </div>
            <div className="photo-preview">
              {slot.preview || slot.photo ? (
                <img
                  src={slot.preview || slot.photo?.url}
                  alt={`${viewLabels[slot.view]} inspection preview`}
                />
              ) : (
                <>
                  <Camera size={35} strokeWidth={1.25} />
                  <span>
                    {slot.view === 'front'
                      ? 'Include hood and windshield'
                      : slot.view === 'rear'
                        ? 'Include bumper and tailgate'
                        : slot.view === 'driver'
                          ? 'Include both wheels and doors'
                          : slot.view === 'passenger'
                            ? 'Include both wheels and doors'
                            : 'Capture the area clearly'}
                  </span>
                </>
              )}
              {slot.busy && (
                <div className="upload-progress">
                  <div style={{ width: `${slot.progress}%` }} />
                  <span>
                    {slot.progress === 100 ? 'Saving photograph…' : `Uploading ${slot.progress}%`}
                  </span>
                </div>
              )}
            </div>
            {slot.photo && (
              <p className="photo-meta">
                {slot.photo.source === 'camera' ? 'Camera capture' : 'Uploaded photograph'}
                <br />
                Device reported: {formatDate(slot.photo.deviceCapturedAt, settings.timezone)}
                <br />
                Received: {formatDate(slot.photo.receivedAt, settings.timezone)}
              </p>
            )}
            {slot.error && (
              <div className="inline-error" role="alert">
                {slot.error}
                <button
                  type="button"
                  className="text-button"
                  onClick={() =>
                    slot.file && send(slot.key, slot.file, slot.source!, slot.capturedAt!)
                  }
                >
                  <RotateCcw size={15} /> Retry upload
                </button>
              </div>
            )}
            <div className="photo-actions">
              <button
                type="button"
                className="button secondary compact"
                disabled={slot.busy}
                onClick={() => setCameraKey(slot.key)}
              >
                <Camera size={16} />
                {slot.photo ? 'Retake' : 'Take photo'}
              </button>
              {settings.allowPhotoImports && (
                <label
                  className={`button ghost compact file-button ${slot.busy ? 'disabled' : ''}`}
                >
                  <Upload size={16} /> Upload
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
                    disabled={slot.busy}
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file)
                        void send(
                          slot.key,
                          file,
                          'upload',
                          new Date(file.lastModified || Date.now()).toISOString(),
                        );
                      event.target.value = '';
                    }}
                  />
                </label>
              )}
            </div>
          </article>
        ))}
      </div>
      <div className="add-photo">
        <select
          aria-label="Additional photograph type"
          value={additionalView}
          onChange={(event) => setAdditionalView(event.target.value)}
        >
          {['damage', 'windshield', 'interior', 'odometer', 'receipt', 'wheels', 'other'].map(
            (view) => (
              <option key={view} value={view}>
                {viewLabels[view]}
              </option>
            ),
          )}
        </select>
        <button
          type="button"
          className="button secondary"
          onClick={() =>
            setSlots((current) => [
              ...current,
              { key: crypto.randomUUID(), view: additionalView, progress: 0, busy: false },
            ])
          }
        >
          <ImagePlus size={18} /> Add photograph
        </button>
      </div>
      <p className="fine">
        Original uploads are retained privately. Device times are reported by this iPad; timestamps
        and watermarks do not verify when a photograph was taken. JPEG, PNG and WebP are supported.
        If HEIC cannot be processed, use the camera above or export a JPEG.
      </p>
      {cameraKey && (
        <div
          className="modal-backdrop camera-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label="Capture vehicle photograph"
        >
          <div className="camera-modal">
            <div className="row between">
              <h3>{viewLabels[slots.find((slot) => slot.key === cameraKey)?.view || 'other']}</h3>
              <button
                type="button"
                className="icon-button"
                aria-label="Close camera"
                onClick={() => setCameraKey(null)}
              >
                <X />
              </button>
            </div>
            {cameraError ? (
              <div className="notice warning">{cameraError}</div>
            ) : (
              <video
                ref={video}
                autoPlay
                muted
                playsInline
                onLoadedData={() => setCameraReady(true)}
                onClick={() => video.current?.play()}
              />
            )}
            <p>Keep the entire view in frame and hold the iPad steady.</p>
            <button
              type="button"
              className="button primary"
              disabled={!cameraReady || !!cameraError}
              onClick={capture}
            >
              <Camera size={20} /> Capture photograph
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
