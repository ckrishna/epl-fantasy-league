// src/pages/Help.jsx
import '../styles/Help.css';

export default function Help() {
  return (
    <div className="help-page">
      <h2>Help & Documentation</h2>

      <div className="help-grid">
        <section className="help-card">
          <h3>📊 Standings Tab</h3>
          <p>View the current league standings for any gameweek. Earnings are calculated as:</p>
          <ul>
            <li>$5 per gameweek for the highest scorer (split if tied)</li>
            <li>$70, $30, $10 bonus for 1st, 2nd, 3rd place at season end</li>
          </ul>
        </section>

        <section className="help-card">
          <h3>🏆 GW Winners Tab</h3>
          <p>See the gameweek winners history throughout the season. Each winner receives their prize share.</p>
        </section>

        <section className="help-card">
          <h3>📈 Stats Tab</h3>
          <p>Use AI-powered queries to analyze league performance. Ask questions like:</p>
          <ul>
            <li>"Who's performing best this week?"</li>
            <li>"Which team's players are in form?"</li>
            <li>"Top transfer targets?"</li>
          </ul>
        </section>

        <section className="help-card">
          <h3>⚙️ How It Works</h3>
          <p>This app:</p>
          <ul>
            <li>Updates nightly with live Premier League data</li>
            <li>Stores historical gameweeks performance</li>
            <li>Uses AI to answer natural language questions</li>
            <li>Hosted on Cloudflare Pages for fast global access</li>
          </ul>
        </section>

        <section className="help-card">
          <h3>📱 Browser Support</h3>
          <p>Works on all modern browsers.</p>
        </section>
      </div>
    </div>
  );
}
