const { CopilotClient, approveAll } = require('@github/copilot-sdk');

(async () => {
  try {
    const client = new CopilotClient({ autoStart: false });
    console.log('CopilotClient created');
    
    // Try creating a session without gitHubToken
    try {
      const session = await client.createSession({
        model: 'gpt-4.1',
        onPermissionRequest: approveAll,
      });
      console.log('Session created successfully (without gitHubToken)');
    } catch (e) {
      console.log('ERROR without gitHubToken:', e.message);
    }
    
  } catch (e) {
    console.error('Fatal error:', e);
  }
})();
