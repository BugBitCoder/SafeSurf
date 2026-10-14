const STAGES = [
  {
    id: 'dom',
    label: 'You type a prompt',
    detail: 'A capture-phase listener sees the submit before the page does.',
    side: 'local',
  },
  {
    id: 'deterministic',
    label: 'Checksummed IDs are replaced',
    detail: 'Verhoeff, Luhn, mod-97. No model involved. The identifier never leaves.',
    side: 'local',
  },
  {
    id: 'redaction',
    label: 'Free-text PII is rephrased',
    detail: 'Gemma 4 rewrites names, employers, diagnoses — and returns the mapping.',
    side: 'local',
  },
  {
    id: 'egress',
    label: 'Egress guard checks the destination',
    detail: 'Anything not http://localhost:11434 is refused before a socket opens.',
    side: 'local',
  },
  {
    id: 'remote',
    label: 'The AI receives the rewritten text',
    detail: 'It sees [AADHAAR_1]. Your device keeps the plaintext, reversibly.',
    side: 'remote',
  },
];

export default function Pipeline() {
  return (
    <section className="pipeline" aria-labelledby="pipeline-heading">
      <h2 id="pipeline-heading">Five steps, four of them local</h2>
      <p className="pipeline-lede">
        The only stage that touches a network is the last one — and it carries text that has
        already been stripped twice.
      </p>

      <ol className="stages">
        {STAGES.map((stage, i) => (
          <li key={stage.id} className={`stage stage--${stage.side}`}>
            <span className="stage-n">{i + 1}</span>
            <div className="stage-body">
              <h3>{stage.label}</h3>
              <p>{stage.detail}</p>
            </div>
            <span className="stage-badge">{stage.side === 'local' ? 'on device' : 'network'}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}