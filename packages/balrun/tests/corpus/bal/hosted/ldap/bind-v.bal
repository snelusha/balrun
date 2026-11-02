import ballerina/io;
import ballerina/ldap;

public function main() returns error? {
    ldap:Client c = check new ({hostName: "127.0.0.1", port: 19620, domainName: "cn=admin", password: "pw"});
    boolean connected = check c->isConnected();
    io:println(connected); // @output true
    check c->close();
}
