OK, there's a lot of examples of running entire operating systems in the browser with WASM or similar backends.  Client-side only apps.  Full operating sytems like windows and linux!  Now I've been writing a lot of TUI apps.  These are things like ortop, media editor, etc. 

It seems to me that what I really want on a website is the following. 

1. Client-side only page.  Never can have a server component. 
2. It boots up an ultra-minimal linux terminal.  Kitty protocol support would be great, but whatever. 
3. This term, it's running (maybe emulated or whatever) linux.  And you can ssh-keygen, so that you can add that to your github.  So it needs a persistent, preferably encrypted disk image or whatever.  You should be able to install all kinds of supporting packages and such, so maybe it needs root or maybe it's running termux.  

Do some deep research.  Is this possible? That would be so convenient if I'm on say, a windows machine and I open up my browser and launch a linux terminal from a website that allows me to use software like fresh-editor and other linux command line software.  Let's come up with some alternative approaches that would allow this.  THe most important thing is that it's client-side only.

I know that pure tcp sockets are not available in a web context.  So that has to be the crux of our research.  Can we get apt and the rest of our linux system to work with regular http requests?  Could we build a http request shim in-memory or in-browser?  Without the ability of these TUI apps to work with github, receive data from APIs, and do real work it's pointless