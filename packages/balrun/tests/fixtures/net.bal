import ballerina/io;
import ballerina/ldap;
import ballerina/udp;

service class EchoService {
    *udp:Service;

    remote function onBytes(readonly & byte[] data) returns byte[] {
        return data;
    }
}

public function main() returns error? {
    udp:Listener server = check new (19610);
    check server.attach(new EchoService());
    check server.'start();

    udp:ConnectClient connected = check new ("localhost", 19610, {timeout: 5});
    check connected->writeBytes("udp ok".toBytes());
    readonly & byte[] reply = check connected->readBytes();
    io:println(check string:fromBytes(reply));
    check server.gracefulStop();

    ldap:Client directory = check new ({hostName: "127.0.0.1", port: 19611, domainName: "cn=admin", password: "pw"});
    boolean isConnected = check directory->isConnected();
    io:println("tcp ok: ", isConnected);

    // Left open on purpose: the process must still exit.
    udp:Client _ = check new ();
}
