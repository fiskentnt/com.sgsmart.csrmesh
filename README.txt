Control older SG LEDDim dimmers from Homey Pro. These are the first generation
that use Bluetooth CSRmesh and advertise as @NDxxxx. No SG gateway is needed;
Homey talks to the dimmers over Bluetooth directly.

This app is unofficial and not affiliated with or endorsed by SG. It does not
work with SG Smart 3.0, which uses a different (SIG Mesh) protocol.

Add a light for each dimmer, or the group device to control a whole CSRmesh
group at once. On/off, dim level and status back from the wall switch are
supported. Commands are encrypted with your installation's network passphrase,
usually 1234; if the lights do not respond, enter your own passphrase from the
SG app in the device settings.

Requires Homey Pro (Bluetooth LE is not available to apps on the Bridge).
