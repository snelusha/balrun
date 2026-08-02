import ballerina/io;

class Listener {
	public function attach(service object {} svc, () attachPoint = ()) returns () {
		var _ = svc;
		var _ = attachPoint;
	}

	public function detach(service object {} svc) returns error? {
		var _ = svc;
	}

	public function 'start() returns error? {
		io:println("Listener started.");
	}

	public function gracefulStop() returns error? {
		io:println("Graceful stop initiated.");
	}

	public function immediateStop() returns error? {
		io:println("Immediate stop initiated.");
	}
}

public listener Listener l = new ();

service on l {}

public function main() {}
