Control your Vektiva SMARWI window openers from Homey.

The app talks to the SMARWI directly over your local network, so opening and closing
a window does not depend on any cloud service. Status changes are pushed by the device
itself, which means Homey follows the window in real time. The vektiva.online API can
be added as an optional fallback, for a SMARWI that lives on a different network than
your Homey.

WHAT YOU GET

- Open, close, stop, and open to a chosen percentage
- A Window dashboard widget that draws the window, shows fresh air streaming in while
  it is open, and puts Open / Stop / Close next to it with a position slider
- The opening percentage recorded in Insights, so you can see when the window was open
- Fix and release the ridge from a Flow, for when you want to move the window by hand
- Flow cards for every action, a trigger for a blocked window, and conditions for the
  readiness and the fixation
- The Finetune values of the device - speed, power, maximum opening - readable and
  writable from the app settings, with an explanation of what each one does
- Connection tests for both the local network and the vektiva.online account

ADDING A DEVICE

Put the SMARWI in Wi-Fi Client mode in its own web interface, then add it in Homey
under Devices. The app scans your network and offers whatever it finds, so there is no
IP address to type in. Reserve a fixed address for the SMARWI in your router.

GOOD TO KNOW

The SMARWI reports only open or closed, never a real percentage, so the app shows the
position it last asked for. Changing the opening while the window is already open makes
the firmware pull the sash back to the frame and extend it again - that is how the
device re-references itself, not a fault of the app.

This is a community app. It is not made by, endorsed by, or supported by Vektiva.

Source and issues: https://github.com/marlo8203/com.vektiva.smarwi
