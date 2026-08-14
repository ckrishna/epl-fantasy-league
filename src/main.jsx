import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import App from './App.jsx'
import './index.css'

// League id lives in the URL path (e.g. epl.candorsolutions.us/438107) so a specific
// league+season is a real, bookmarkable/shareable link instead of only reachable via the
// in-app dropdown. `/:leagueId` covers a real id; `/` (no id yet) and `*` (anything else
// -- typos, an id that's since been recycled to an unrelated league, etc) both still
// render App, which resolves the actual season to show (or redirects to the current
// league's own URL) once it has the seasons list -- see the effect in App.jsx. Keeping
// all three routes point at the same component means there's exactly one place that
// decides what counts as a valid league id, not one in the router and one in App.
ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<App />} />
        <Route path="/:leagueId" element={<App />} />
        <Route path="*" element={<App />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
)
