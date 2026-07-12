import { pickText } from '@screening/engine';

// Allow-listed component registry: XML can select only these field types.
export function FieldInput({ field, value, file, error, onChange, onFile }) {
  const label = pickText(field.label);
  const errorId = `${field.id}-error`;

  let control;
  switch (field.type) {
    case 'choice':
      control = (
        <div role="radiogroup" aria-label={label || field.id} className="choices">
          {field.options.map((option) => (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={value === option.value}
              className={value === option.value ? 'choice selected' : 'choice'}
              onClick={() => onChange(option.value)}
            >
              {pickText(option.label)}
            </button>
          ))}
        </div>
      );
      break;
    case 'number':
      control = (
        <div className="number-row">
          <input
            type="number"
            inputMode="decimal"
            step="0.1"
            value={value ?? ''}
            min={field.min}
            max={field.max}
            aria-label={label || field.id}
            aria-describedby={error ? errorId : undefined}
            onChange={(event) => onChange(event.target.value)}
          />
          {field.unit && <span className="unit">{field.unit}</span>}
        </div>
      );
      break;
    case 'text':
      control = (
        <input
          type="text"
          value={value ?? ''}
          maxLength={400}
          aria-label={label || field.id}
          onChange={(event) => onChange(event.target.value)}
        />
      );
      break;
    case 'image':
      control = (
        <div className="image-field">
          <input
            id={`file-${field.id}`}
            type="file"
            accept={field.accept?.join(',') ?? 'image/jpeg,image/png'}
            onChange={(event) => onFile(event.target.files?.[0])}
          />
          {file && (
            <div className="image-preview">
              <img src={URL.createObjectURL(file)} alt="Selected reading" />
              <button type="button" className="link" onClick={() => onFile(undefined)}>Remove photo</button>
            </div>
          )}
        </div>
      );
      break;
    default:
      return (
        <div className="error-box" role="alert">
          This screening uses a field type this app does not support (&quot;{field.type}&quot;).
          Ask for the app to be updated. The screening was stopped to stay safe.
        </div>
      );
  }

  return (
    <div className="field">
      {label && <label htmlFor={`file-${field.id}`}>{label}{field.required ? '' : ' (optional)'}</label>}
      {control}
      {error && <p className="field-error" id={errorId} role="alert">{error}</p>}
    </div>
  );
}
