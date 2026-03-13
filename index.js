'use strict';

module.exports = function (RED) {
    require('./nodes/copilot-config/copilot-config')(RED);
    require('./nodes/copilot-prompt/copilot-prompt')(RED);
};
