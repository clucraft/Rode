import { Panel } from './Settings.jsx';

/** Filled in phase 7 with recipients, channels and delivery verification. */
export function Notifications() {
  return (
    <Panel title="Notifications">
      <p className="muted">
        Notification channels arrive in the next phase: ntfy, Pushover, Telegram, webhook/MQTT and
        email for the daily heartbeat.
      </p>
    </Panel>
  );
}
