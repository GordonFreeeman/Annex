import brut.androlib.src.SmaliBuilder;
import brut.androlib.src.SmaliDecoder;
import brut.directory.ExtFile;
import java.io.File;
/** D8 dex -> baksmali -> smali -> dex (independent, canonical writer: sorted pools, checksum, SHA-1 signature). */
public class Resmali {
    public static void main(String[] a) throws Exception {
        File zip = new File(a[0]), outDir = new File(a[1]), dex = new File(a[2]);
        SmaliDecoder.decode(zip, outDir, "classes.dex", false, 21);
        SmaliBuilder.build(new ExtFile(outDir), dex, 21);
        System.out.println("ok");
    }
}
