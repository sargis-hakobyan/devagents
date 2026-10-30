import { render } from 'preact';
import { LocationProvider, Router, Route, useLocation } from 'preact-iso';
import { useEffect } from 'preact/hooks';
import './styles.css';
import { session } from './api';
import { setSignedOutHandler, usePoll } from './state';
import { Shell } from './components/Shell';
import { OverviewPage } from './pages/Overview';
import { TasksPage } from './pages/Tasks';
import { TaskDetailPage } from './pages/TaskDetail';
import { ProjectsPage, SettingsPage, SignedOutPage } from './pages/Simple';
import { RegisterProjectPage } from './pages/RegisterProject';
import { TeamEditorPage, TeamsPage } from './pages/Teams';

function App() {
  const { path, route } = useLocation();
  useEffect(() => { setSignedOutHandler(() => route('/ui/signed-out')); }, []);
  if (path === '/ui/signed-out') return <SignedOutPage />;
  return <Authenticated />;
}
// The router renders a matched page once per URL, so every page subscribes to its own data through
// the shared pollers instead of receiving it from here.
function Authenticated() {
  const auth = usePoll('session', () => session(), 5 * 60 * 1000);
  if (!auth.data && !auth.error) return <div class="app"><div class="band"><span class="brand-name">devagents</span></div><main class="main"><div class="sk" style={{ width: '40%', height: '20px' }} /></main></div>;
  return <Shell>
    <Router>
      <Route path="/ui/" component={OverviewPage} />
      <Route path="/ui" component={OverviewPage} />
      <Route path="/ui/tasks" component={TasksPage} />
      <Route path="/ui/tasks/:id" component={({ id }: { id: string }) => <TaskDetailPage id={id} />} />
      <Route path="/ui/teams" component={TeamsPage} />
      <Route path="/ui/teams/:id" component={({ id }: { id: string }) => <TeamEditorPage id={id} />} />
      <Route path="/ui/projects/new" component={RegisterProjectPage} />
      <Route path="/ui/projects" component={ProjectsPage} />
      <Route path="/ui/settings" component={SettingsPage} />
      <Route default component={() => <div class="note info">Unknown page. <a href="/ui/">Back to the overview</a></div>} />
    </Router>
  </Shell>;
}
render(<LocationProvider><App /></LocationProvider>, document.getElementById('app')!);
