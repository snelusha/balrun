import ballerina/io;
import ballerina/udp;

public function main() returns error? {
    // Left open on purpose: the run must still finish and the process must still exit.
    udp:Client _ = check new ();
    io:println("done"); // @output done
}
