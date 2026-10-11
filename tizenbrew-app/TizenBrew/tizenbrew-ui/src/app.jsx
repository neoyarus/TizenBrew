import { LocationProvider, ErrorBoundary, Router, Route } from 'preact-iso';
import Home from './pages/Home.jsx';
import ModuleManager, { AddModule } from './pages/ModuleManager.jsx';
import Header from './components/Header.jsx';
import { GlobalStateContext } from './components/ClientContext.jsx';
import { useEffect, useContext } from 'react';
import Client from './components/WebSocketClient.js';
import Settings, { Change } from './pages/Settings.jsx';
import About from './pages/About.jsx';
import './components/i18n.js';
import UserAgentSettings from './pages/UserAgentSettings.jsx';
import { ExclamationCircleIcon } from '@heroicons/react/16/solid';
import { useTranslation } from 'react-i18next';

export default function App() {
  const context = useContext(GlobalStateContext);
  const { t } = useTranslation();
  window.dispatch = context.dispatch;
  window.state = context.state;

  useEffect(() => {
    if (context.state.sharedData.error.disappear) {
      setTimeout(() => {
        context.dispatch({
          type: 'SET_ERROR',
          payload: {
            message: null,
            disappear: false
          }
        });
      }, 5000);
    }
  }, [context.state.sharedData.error.disappear]);

  useEffect(() => {
    if (!window.setClient) {
      startService(context);
      window.setClient = true;
    }
  }, []);


  return (
    <ErrorBoundary>
      <LocationProvider>
        {context.state.sharedData.startupPending ? (
          <div className="startup-screen" role="status" aria-busy="true">TizenBrew</div>
        ) : (<div className="flex flex-col h-screen">
        <div className="shrink-0"><Header /></div>
        <div className="bg-slate-800 text-white overflow-hidden flex-1 min-h-0">
          <div className={`flex justify-center ${!context.state.sharedData.error.message ? 'hidden' : ''}`}>
            <div class="flex items-center p-4 mb-4 text-sm text-red-800 rounded-lg bg-red-50 bg-slate-900 mt-8 w-[95vw] text-red-400" role="alert">
              <ExclamationCircleIcon className="h-[4vw] w-[2vw] mr-2" />
              <div>
                <span class="text-2xl">{t(context.state.sharedData.error.message, context.state.sharedData.error.args)}</span>
              </div>
            </div>
          </div>
          <Router>
            <Route component={Home} path="/tizenbrew-ui/dist/index.html" />
            <Route component={ModuleManager} path="/tizenbrew-ui/dist/index.html/module-manager" />
            <Route component={AddModule} path="/tizenbrew-ui/dist/index.html/module-manager/add" />
            <Route component={Settings} path="/tizenbrew-ui/dist/index.html/settings" />
            <Route component={Change} path="/tizenbrew-ui/dist/index.html/settings/change" />
            <Route component={UserAgentSettings} path="/tizenbrew-ui/dist/index.html/settings/change-ua" />
            <Route component={About} path="/tizenbrew-ui/dist/index.html/about" />
          </Router>
        </div>
        </div>)}
      </LocationProvider>
    </ErrorBoundary>
  );
}


function startService(context) {
  let serviceLaunched = false;
  let finished = false;
  let currentSocket;
  let retryTimer;
  let socketTimer;

  function discardSocket() {
    clearTimeout(socketTimer);
    if (currentSocket) {
      currentSocket.onopen = currentSocket.onerror = currentSocket.onclose = null;
      currentSocket.close();
    }
  }

  function fail(message) {
    if (finished) return;
    finished = true;
    clearTimeout(deadline);
    clearTimeout(retryTimer);
    discardSocket();
    context.dispatch({ type: 'SET_ERROR', payload: { message, disappear: false } });
  }

  // Service launch acknowledges the request before its websocket is listening.
  // Reconnect in place rather than reloading the entire UI and showing another splash.
  const deadline = setTimeout(() => fail('errors.serviceDidntConnectYet'), 10000);

  function connect() {
    if (finished) return;
    const ws = currentSocket = new WebSocket('ws://localhost:8081');
    let settled = false;

    function unavailable() {
      if (finished || settled) return;
      settled = true;
      discardSocket();
      if (serviceLaunched) {
        retryTimer = setTimeout(connect, 100);
        return;
      }
      serviceLaunched = true;
      const serviceId = tizen.application.getCurrentApplication().appInfo.packageId + '.StandaloneService';
      try {
        tizen.application.launchAppControl(
          new tizen.ApplicationControl('http://tizen.org/appcontrol/operation/service'),
          serviceId,
          () => {
            if (finished) return;
            context.dispatch({ type: 'SET_STATE', payload: 'service.started' });
            retryTimer = setTimeout(connect, 100);
          },
          e => fail('Launch Service failed: ' + e.message)
        );
      } catch (e) {
        fail('Launch Service failed: ' + e.message);
      }
    }

    ws.onerror = ws.onclose = unavailable;
    socketTimer = setTimeout(unavailable, 1000);
    ws.onopen = () => {
      if (finished || settled) return;
      settled = finished = true;
      clearTimeout(deadline);
      clearTimeout(socketTimer);
      context.dispatch({ type: 'SET_STATE', payload: serviceLaunched ? 'service.started' : 'service.alreadyRunning' });
      context.dispatch({ type: 'SET_CLIENT', payload: new Client(context, ws) });
    };
  }

  connect();
}
