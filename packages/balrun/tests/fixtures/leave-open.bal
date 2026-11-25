import ballerina/io;

public function main() returns error? {
    io:WritableByteChannel file = check io:openWritableFile("out.txt");
    _ = check file.write("text".toBytes(), 0);
}
