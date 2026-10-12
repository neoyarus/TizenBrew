(function () {
    'use strict';
    var status = document.getElementById('status');
    var returnButton = document.getElementById('return');
    var generation = 0;
    var wasHidden = document.hidden === true;
    var deadline;

    function returnToTv() {
        try { tizen.application.getCurrentApplication().hide(); }
        catch (error) { status.textContent = 'Use the Home button to return to TV.'; }
    }

    returnButton.onclick = returnToTv;
    document.addEventListener('keydown', function (event) {
        if (event.keyCode === 10009 || event.keyCode === 27) {
            event.preventDefault();
            returnToTv();
        }
    });
    document.addEventListener('visibilitychange', function () {
        var hidden = document.hidden === true;
        if (wasHidden && !hidden) launchService();
        wasHidden = hidden;
    });
    returnButton.focus();

    function launchService() {
        clearTimeout(deadline);
        var attempt = ++generation;
        var settled = false;
        status.textContent = 'Starting the recovery service…';
        function finish(message) {
            if (settled || attempt !== generation) return;
            settled = true;
            clearTimeout(deadline);
            status.textContent = message;
        }
        deadline = setTimeout(function () {
            finish('Service launch could not be confirmed. Verify its status from your computer or reopen this app.');
        }, 10000);
        try {
            var serviceId = tizen.application.getCurrentApplication().appInfo.packageId + '.RecoveryService';
            tizen.application.launchAppControl(
                new tizen.ApplicationControl('http://tizen.org/appcontrol/operation/service'),
                serviceId,
                function () { finish('Service launch requested. Verify recovery readiness from your computer.'); },
                function () { finish('Unable to start the recovery service. Reopen this app to retry.'); }
            );
        } catch (error) {
            finish('Unable to start the recovery service on this TV.');
        }
    }
    launchService();
}());
