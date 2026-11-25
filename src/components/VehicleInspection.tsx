import { useState } from 'react';
import { errorMessage, post } from '../api';

export type VehicleInspection = { id: string; name: string; plate: string; site: string };

export function VehicleInspectionForm({
  task,
  onResolved,
}: {
  task: VehicleInspection;
  onResolved: () => void;
}) {
  const [inspected, setInspected] = useState(false);
  const [decision, setDecision] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <details className="vehicle-inspection">
      <summary>
        {task.name} · {task.plate} · {task.site}
      </summary>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (busy) return;
          setBusy(true);
          setError('');
          try {
            await post(`/vehicle-inspections/${task.id}/resolve`, { inspected, decision, reason });
            onResolved();
          } catch (cause) {
            setError(errorMessage(cause));
            setBusy(false);
          }
        }}
      >
        <p>
          There is no current return form for this inspection. Inspect the vehicle, emergency kits,
          keys, and odometer in person before deciding whether it can return to service.
        </p>
        <label className="check-label">
          <input
            type="checkbox"
            required
            checked={inspected}
            onChange={(event) => setInspected(event.target.checked)}
          />
          I physically inspected this vehicle and was not the driver for this return.
        </label>
        <label>
          Inspection decision
          <select required value={decision} onChange={(event) => setDecision(event.target.value)}>
            <option value="">Choose a decision</option>
            <option value="approve">Make available for checkout</option>
            <option value="hold">Take out of service</option>
          </select>
        </label>
        <label>
          Inspection notes
          <textarea
            required
            minLength={5}
            maxLength={2000}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </label>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <button
          className="button primary"
          disabled={busy || !inspected || !decision || reason.trim().length < 5}
        >
          {busy ? 'Saving…' : 'Complete inspection'}
        </button>
      </form>
    </details>
  );
}
